import { withLlcAccessControl } from "@/trpc/api/trpc";
import { loadPacketView } from "../packet";
import { ZodPacketPublicIdSchema } from "../schema";

// admission.get (F13): everything the Manager confirmation screen shows for
// one Exhibit B packet: stage, the investor's answers (after signing), the
// member record, the commitment, W-9s, the Manager signer, the figures the
// countersignature will print and the class terms the decision dialog needs.
export const getPacketProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["read"] } } })
  .input(ZodPacketPublicIdSchema)
  .query(({ ctx, input }) =>
    loadPacketView(
      ctx.db,
      ctx.company,
      input.publicId,
      ctx.membership.memberId,
    ),
  );
