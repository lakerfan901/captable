import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PacketReview } from "@/components/llc/admission/confirm/packet-review";
import { sanitizeView } from "@/components/llc/admission/confirm/view";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Review subscription",
};

// Manager confirmation screen for one Exhibit B packet (01-foundation.md
// F13): review the answers, confirm the details, record the wire, decide,
// countersign. Reading needs `commitments: read`; each control checks the
// permission its procedure needs.

const rethrowUnlessNotFound = (error: unknown): never => {
  if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
  throw error;
};

export default async function SubscriptionReviewPage(props: {
  params: Promise<{ publicId: string; templatePublicId: string }>;
}) {
  await requireLlc();
  const { publicId, templatePublicId } = await props.params;
  const { allow } = await serverAccessControl();

  // Thunks so a procedure the caller may not use is never called.
  const loadView = allow(
    () =>
      api.admission
        .get({ publicId: templatePublicId })
        .catch(rethrowUnlessNotFound),
    ["commitments", "read"],
  );
  const view = loadView ? await loadView() : null;
  if (!view) {
    return <UnAuthorizedState />;
  }

  const canReadDocuments = allow(true, ["documents", "read"], false);
  const loadMembers = allow(() => api.member.getMembers(), ["members", "read"]);
  const members = loadMembers ? await loadMembers() : null;
  const managers = members
    ? members.data.flatMap((m) =>
        m.status === "ACTIVE" && m.user?.name && m.user.email
          ? [{ memberId: m.id, name: m.user.name, email: m.user.email }]
          : [],
      )
    : null;

  return (
    <PacketReview
      view={sanitizeView(view, canReadDocuments)}
      companyPublicId={publicId}
      managers={managers}
      canReadDocuments={canReadDocuments}
    />
  );
}
