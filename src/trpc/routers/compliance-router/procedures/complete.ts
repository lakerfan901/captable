import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZComplianceCompleteSchema } from "../schema";
import {
  auditContext,
  badRequest,
  linkedNotFound,
  loadDeadline,
  ONLY_OPEN,
  userName,
} from "./shared";

// compliance.complete (03-governance.md G14): OPEN deadlines only. A
// RESOLUTION, MEMBER_REPORT or DOCUMENT is resolved by `{ publicId,
// companyId }` (NOT_FOUND otherwise, so another company's row is never
// linked) and its id is stored. MANUAL requires a note.

const TARGET_TYPE = {
  RESOLUTION: "resolution",
  MEMBER_REPORT: "memberReport",
  DOCUMENT: "document",
} as const;

export const completeProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZComplianceCompleteSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const note = input.note && input.note !== "" ? input.note : null;

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadDeadline(tx, companyId, input.id);
      if (row.status !== "OPEN") badRequest(ONLY_OPEN);

      let satisfiedById: string | null = null;
      let label = "other evidence";
      const type = input.satisfiedByType;
      if (type === "MANUAL") {
        if (note === null) badRequest("Enter a note saying how it was done.");
      } else {
        const publicId = input.satisfiedByPublicId;
        if (publicId === undefined) {
          badRequest("Choose what satisfied the deadline.");
        }
        if (type === "RESOLUTION") {
          const r = await tx.resolution.findFirst({
            where: { publicId, companyId },
            select: { id: true, referenceCode: true, title: true },
          });
          if (!r) linkedNotFound("Resolution");
          satisfiedById = r.id;
          label = `resolution ${r.referenceCode ?? r.title}`;
        } else if (type === "MEMBER_REPORT") {
          const r = await tx.memberReport.findFirst({
            where: { publicId, companyId },
            select: { id: true, title: true },
          });
          if (!r) linkedNotFound("Report");
          satisfiedById = r.id;
          label = `report "${r.title}"`;
        } else {
          const d = await tx.document.findFirst({
            where: { publicId, companyId },
            select: { id: true, name: true },
          });
          if (!d) linkedNotFound("Document");
          satisfiedById = d.id;
          label = `document "${d.name}"`;
        }
      }

      const ok = await guardedWrite(() =>
        tx.complianceDeadline.update({
          where: { id: row.id, companyId, status: "OPEN" },
          data: {
            status: "DONE",
            completedAt: new Date(),
            completedById: ctx.membership.memberId,
            satisfiedByType: type,
            satisfiedById,
            note,
          },
          select: { id: true },
        }),
      );
      if (!ok) badRequest(ONLY_OPEN);

      await Audit.create(
        {
          action: "compliance.completed",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [
            { type: "complianceDeadline", id: row.id },
            ...(type !== "MANUAL" && satisfiedById !== null
              ? [{ type: TARGET_TYPE[type], id: satisfiedById }]
              : []),
          ],
          summary: `${userName(ctx)} marked the deadline "${row.title}" done (${label})`,
        },
        tx,
      );
      return { id: row.id };
    });
  });
