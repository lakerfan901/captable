import { withoutAuth } from "@/trpc/api/trpc";
import { ZReportTokenSchema } from "../schema";
import { resolveRecipient } from "./resolve";

// memberReportView.route (04-investor-portal.md P25, P26, 6.1; package P5b).
// Public: the token is the credential. What `/member-reports/{token}` shows:
//
// - LEGACY: the read-only page as today (`view` returns the content). Sent
//   before the portal (`publishedAt` null): `reportId` null, the page is
//   exactly today's. Published, addressee never invited at this address:
//   `reportId` set, so the page can offer "Sign in to the portal" leading to
//   that report for a reader who does have an account.
// - WITHDRAWN: unpublished, "This report is no longer available."
// - PORTAL: published and the addressee has an ACTIVE access to the holder;
//   `reportId` (public id) for the sign-in `next`, `setupNeeded` when no
//   password is set yet ("Email me my set-up link").
// - ACCESS_OFF: the addressee's access was turned off.
// - REPLACED: the link was revoked or replaced.
// An invalid, expired or foreign token is the same message-less NOT_FOUND
// as in `view`.
//
// Never returns report content, the recipient's name or address, or any
// internal id: the company's name and logo and, where stated, the report's
// public id (an identifier, not a credential; S25). A mutation (POST) so the
// token never travels in a URL; rate-limited with the other token
// procedures (`token-api` bucket).

export const routeProcedure = withoutAuth
  .input(ZReportTokenSchema)
  .mutation(async ({ ctx, input }) => {
    const resolved = await resolveRecipient(ctx.db, input.token, new Date());
    switch (resolved.kind) {
      case "OK":
        return {
          state: "LEGACY" as const,
          company: {
            name: resolved.company.name,
            logo: resolved.company.logo,
          },
          reportId:
            resolved.report.publishedAt === null
              ? null
              : resolved.report.publicId,
          setupNeeded: false,
        };
      case "PORTAL":
        return {
          state: "PORTAL" as const,
          company: resolved.company,
          reportId: resolved.reportPublicId,
          setupNeeded: resolved.setupNeeded,
        };
      default:
        return {
          state: resolved.kind,
          company: resolved.company,
          reportId: null,
          setupNeeded: false,
        };
    }
  });
