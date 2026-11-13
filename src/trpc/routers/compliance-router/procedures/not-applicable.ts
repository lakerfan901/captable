import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZComplianceMarkNotApplicableSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadDeadline,
  ONLY_OPEN,
  userName,
} from "./shared";

// compliance.markNotApplicable (03-governance.md G14): OPEN deadlines only,
// with a required note. The audit action is `compliance.updated` (the plan
// adds no separate action).

export const markNotApplicableProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZComplianceMarkNotApplicableSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadDeadline(tx, companyId, input.id);
      if (row.status !== "OPEN") badRequest(ONLY_OPEN);

      const ok = await guardedWrite(() =>
        tx.complianceDeadline.update({
          where: { id: row.id, companyId, status: "OPEN" },
          data: {
            status: "NOT_APPLICABLE",
            completedAt: new Date(),
            completedById: ctx.membership.memberId,
            satisfiedByType: null,
            satisfiedById: null,
            note: input.note,
          },
          select: { id: true },
        }),
      );
      if (!ok) badRequest(ONLY_OPEN);

      await Audit.create(
        {
          action: "compliance.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "complianceDeadline", id: row.id }],
          summary: `${userName(ctx)} marked the deadline "${row.title}" not applicable: ${input.note}`,
        },
        tx,
      );
      return { id: row.id };
    });
  });
