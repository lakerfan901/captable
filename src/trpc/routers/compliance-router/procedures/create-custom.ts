import { randomUUID } from "node:crypto";
import { toDateOnly } from "@/lib/date-only";
import {
  CUSTOM_DEADLINE_TEMPLATES,
  normalizeSection,
  templateDueOn,
} from "@/lib/governance/compliance-core";
import { addDays, ymdToUtcDate } from "@/lib/governance/dates";
import { addBusinessDays } from "@/lib/llc/business-days";
import { Audit } from "@/server/audit";
import { getOrCreateLlcTerm } from "@/server/llc/economics/term";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZComplianceCreateCustomSchema } from "../schema";
import { auditContext, badRequest, userName } from "./shared";

// compliance.createCustom (03-governance.md G14): a Manager-entered deadline.
// Either `dueOn`, or `templateKey` + `triggerOn` (the due date is computed
// from the template offset; business-day offsets use ECONOMICS
// `addBusinessDays` with the company's holiday settings). A template without
// an offset (statutory items) needs `dueOn`.

export const createCustomProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["create"] } } })
  .input(ZComplianceCreateCustomSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const template = input.templateKey
      ? CUSTOM_DEADLINE_TEMPLATES[input.templateKey]
      : null;

    return await ctx.db.$transaction(async (tx) => {
      let dueOn: string;
      if (input.triggerOn !== undefined) {
        if (template === null) {
          badRequest("A trigger date needs a deadline template.");
        }
        if (template.offset === null) {
          badRequest("This template has no offset; enter the due date.");
        }
        if (input.dueOn !== undefined) {
          badRequest("Enter either a due date or a trigger date, not both.");
        }
        const term = await getOrCreateLlcTerm(tx, companyId);
        const computed = templateDueOn(
          template,
          input.triggerOn,
          (d, n) =>
            addBusinessDays(d, n, {
              holidays: term.holidayCalendar,
              saturdayObservedOnFriday: term.saturdayHolidayObservedFriday,
              extraHolidays: term.extraHolidays.map(toDateOnly),
            }),
          addDays,
        );
        if (computed === null) {
          badRequest("This template has no offset; enter the due date.");
        }
        dueOn = computed;
      } else if (input.dueOn !== undefined) {
        dueOn = input.dueOn;
      } else {
        badRequest("Enter a due date, or a template and its trigger date.");
      }

      const section =
        input.section !== undefined
          ? normalizeSection(input.section)
          : (template?.section ?? null);
      const description =
        input.description && input.description !== ""
          ? input.description
          : null;

      const row = await tx.complianceDeadline.create({
        data: {
          companyId,
          ruleKey: "CUSTOM",
          dedupeKey: `CUSTOM:${randomUUID()}`,
          title: input.title,
          section,
          description,
          dueOn: ymdToUtcDate(dueOn),
          source: "MANUAL",
        },
        select: { id: true },
      });

      await Audit.create(
        {
          action: "compliance.created",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "complianceDeadline", id: row.id }],
          summary: `${userName(ctx)} added the deadline "${input.title}" due ${dueOn}`,
        },
        tx,
      );
      return { id: row.id, dueOn };
    });
  });
