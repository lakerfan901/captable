import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportSendSchema } from "../schema";
import { releaseReport } from "./release";

// memberReport.send — LEGACY entry point (03-governance.md G12), kept until
// the release dialog (04-investor-portal.md package P4c) calls
// `memberReport.release` and the review dialog that calls this is removed.
//
// It is `release` (release.ts) with the default audience of the report type
// (R22, R22a: current Members; the other Preferred Members for a transfer
// notice; the holders with a K-1 attached for TAX_K1), derived on the server
// under the locks, and email ticked. So it does what `send` did (same
// recipients, frozen content and hash, books closed, deadlines, emails, filed
// PDF; release.integration.ts compares it with a recorded `send`) and also
// publishes the report (`publishedAt`) and audits `memberReport.released`.

export { periodNotEndedMessage } from "./release";

export const sendProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportSendSchema)
  .mutation(async ({ ctx, input }) => {
    const result = await releaseReport(ctx, {
      publicId: input.publicId,
      audience: { kind: "DEFAULT" },
      email: true,
    });
    return {
      publicId: result.publicId,
      recipientCount: result.recipientCount,
    };
  });
