import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZComplianceReopenSchema } from "../schema";
import { auditContext, badRequest, loadDeadline, userName } from "./shared";

// compliance.reopen (03-governance.md G14): DONE or NOT_APPLICABLE → OPEN,
// clearing the completion fields. A ledger (`E:`) deadline that ECONOMICS
// still reports as done is completed again by the next sync.

const ONLY_CLOSED =
  "Only a completed or not-applicable deadline can be reopened.";

export const reopenProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZComplianceReopenSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadDeadline(tx, companyId, input.id);
      if (row.status === "OPEN") badRequest(ONLY_CLOSED);

      const ok = await guardedWrite(() =>
        tx.complianceDeadline.update({
          where: { id: row.id, companyId, status: row.status },
          data: {
            status: "OPEN",
            completedAt: null,
            completedById: null,
            satisfiedByType: null,
            satisfiedById: null,
            note: null,
          },
          select: { id: true },
        }),
      );
      if (!ok) badRequest(ONLY_CLOSED);

      await Audit.create(
        {
          action: "compliance.reopened",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "complianceDeadline", id: row.id }],
          summary: `${userName(ctx)} reopened the deadline "${row.title}"`,
        },
        tx,
      );
      return { id: row.id };
    });
  });
