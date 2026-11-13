import { generatePublicId } from "@/common/id";
import { Audit } from "@/server/audit";
import { INVESTOR_ROLE, MANAGER_ROLE } from "@/server/llc/admission";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZodCreateMasterSchema } from "../schema";

// admission.createMaster (F12, B22): an Exhibit B master on an uploaded PDF,
// with the two role recipients. The client then opens the field editor at
// /documents/esign/<publicId>. A master stays DRAFT forever.
export const createMasterProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["create"] } } })
  .input(ZodCreateMasterSchema)
  .mutation(({ ctx, input }) => {
    const { companyId, memberId } = ctx.membership;
    const user = ctx.session.user;

    return ctx.db.$transaction(async (tx) => {
      await assertCompanyOwns(tx, companyId, { bucketIds: [input.bucketId] });

      const master = await tx.template.create({
        data: {
          name: input.name,
          publicId: generatePublicId(),
          status: "DRAFT",
          isMaster: true,
          workflow: "SUBSCRIPTION",
          orderedDelivery: true,
          bucketId: input.bucketId,
          uploaderId: memberId,
          companyId,
        },
        select: { id: true, publicId: true },
      });
      // One after the other: signing order 1, then 2.
      await tx.esignRecipient.create({
        data: {
          templateId: master.id,
          role: INVESTOR_ROLE,
          signingOrder: 1,
          name: "Investor",
          email: "investor@placeholder.invalid",
        },
      });
      await tx.esignRecipient.create({
        data: {
          templateId: master.id,
          role: MANAGER_ROLE,
          signingOrder: 2,
          name: "Manager",
          email: "manager@placeholder.invalid",
        },
      });

      await Audit.create(
        {
          action: "admission.master-created",
          companyId,
          actor: { type: "user", id: user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "template", id: master.id }],
          summary: `${user.name ?? "A team member"} created the subscription master "${input.name}"`,
        },
        tx,
      );

      return { publicId: master.publicId };
    });
  });
