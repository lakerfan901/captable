import { utcDateToYmd, ymdToUtcDate } from "@/lib/governance/dates";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZComplianceUpdateSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadDeadline,
  ONLY_OPEN,
  userName,
} from "./shared";

// compliance.update (03-governance.md G14): OPEN deadlines only. The title is
// editable for CUSTOM rows only; the due date for CUSTOM and K1_FINAL (the
// September 15 date is an assumption, R25). A new due date resets the
// reminder buckets. The description is editable on any OPEN row.

export const updateProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZComplianceUpdateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadDeadline(tx, companyId, input.id);
      if (row.status !== "OPEN") badRequest(ONLY_OPEN);

      const isCustom = row.ruleKey === "CUSTOM";
      if (input.title !== undefined && !isCustom) {
        badRequest("Only the title of a custom deadline can be changed.");
      }
      if (
        input.dueOn !== undefined &&
        !isCustom &&
        row.ruleKey !== "K1_FINAL"
      ) {
        badRequest(
          "Only the due date of a custom deadline or of the extended K-1 deadline can be changed.",
        );
      }

      const oldDueOn = utcDateToYmd(row.dueOn);
      const dueChanged = input.dueOn !== undefined && input.dueOn !== oldDueOn;
      const description =
        input.description === undefined
          ? undefined
          : input.description === ""
            ? null
            : input.description;

      const ok = await guardedWrite(() =>
        tx.complianceDeadline.update({
          where: { id: row.id, companyId, status: "OPEN" },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(dueChanged && input.dueOn !== undefined
              ? { dueOn: ymdToUtcDate(input.dueOn), remindedBuckets: [] }
              : {}),
          },
          select: { id: true },
        }),
      );
      if (!ok) badRequest(ONLY_OPEN);

      const changes = [
        input.title !== undefined && input.title !== row.title
          ? `title "${input.title}"`
          : null,
        dueChanged ? `due date ${oldDueOn} → ${input.dueOn}` : null,
        description !== undefined ? "description" : null,
      ].filter((c) => c !== null);
      await Audit.create(
        {
          action: "compliance.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "complianceDeadline", id: row.id }],
          summary: `${userName(ctx)} updated the deadline "${row.title}"${
            changes.length > 0 ? `: ${changes.join(", ")}` : ""
          }`,
        },
        tx,
      );
      return { id: row.id };
    });
  });
