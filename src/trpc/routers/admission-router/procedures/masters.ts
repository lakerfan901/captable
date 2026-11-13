import { missingSubscriptionKeys } from "@/lib/esign/subscription-fields";
import { withLlcAccessControl } from "@/trpc/api/trpc";

// admission.masters (F12): the company's Exhibit B masters that can be sent.
export const mastersProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["read"] } } })
  .query(async ({ ctx }) => {
    const companyId = ctx.membership.companyId;
    const masters = await ctx.db.template.findMany({
      where: {
        companyId,
        isMaster: true,
        workflow: "SUBSCRIPTION",
        status: "DRAFT",
      },
      select: {
        id: true,
        publicId: true,
        name: true,
        createdAt: true,
        fields: { select: { semanticKey: true, recipientId: true } },
        eSignRecipient: { select: { id: true, role: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    return masters.map((master) => {
      const roleOf = new Map(master.eSignRecipient.map((r) => [r.id, r.role]));
      const missingKeys = missingSubscriptionKeys(
        master.fields.map((field) => ({
          semanticKey: field.semanticKey,
          role: roleOf.get(field.recipientId) ?? null,
        })),
      );
      return {
        id: master.id,
        publicId: master.publicId,
        name: master.name,
        createdAt: master.createdAt,
        fieldCount: master.fields.length,
        missingKeys,
        ready: missingKeys.length === 0,
      };
    });
  });
