import type { RouterOutputs } from "@/trpc/shared";

// Shared by the page (server) and the confirmation screen (client).

export type PacketView = RouterOutputs["admission"]["get"];

export type ManagerOption = { memberId: string; name: string; email: string };

/**
 * Storage keys are only kept for callers with `documents: read` (they are
 * never rendered; the Open buttons ask the authenticated document action for
 * a short-lived link).
 */
export function sanitizeView(
  view: PacketView,
  canReadDocuments: boolean,
): PacketView {
  if (canReadDocuments) return view;
  return {
    ...view,
    w9Documents: view.w9Documents.map((d) => ({ ...d, bucketKey: "" })),
    signedDocument: view.signedDocument
      ? { ...view.signedDocument, bucketKey: "" }
      : null,
  };
}
