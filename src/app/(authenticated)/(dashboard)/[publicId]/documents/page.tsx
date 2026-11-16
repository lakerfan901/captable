import { RiUploadCloudLine } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { PageLayout } from "@/components/dashboard/page-layout";
import { Card } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { checkMembership, withServerComponentSession } from "@/server/auth";
import { db } from "@/server/db";
import { getSessionEntity } from "@/server/entity";
import { currentMailDelivery } from "@/server/mail-delivery";
import { api } from "@/trpc/server";
import DocumentsTable, { type DocumentsPortalProps } from "./components/table";
import { DocumentUploadButton } from "./document-upload-button";

export const metadata: Metadata = {
  title: "Documents",
};

/**
 * Holders on each document's share list (04-investor-portal.md 6.2,
 * "Shared with"; package P9a). Rows of a holder that no longer exists are
 * not counted: the portal never shows them.
 */
async function sharedCounts(
  companyId: string,
): Promise<Record<string, number>> {
  const grants = await db.portalDocumentGrant.findMany({
    where: { companyId },
    select: { documentId: true, stakeholderId: true },
  });
  if (grants.length === 0) return {};
  const holders = await db.stakeholder.findMany({
    where: {
      companyId,
      id: { in: [...new Set(grants.map((g) => g.stakeholderId))] },
    },
    select: { id: true },
  });
  const live = new Set(holders.map((h) => h.id));
  const out: Record<string, number> = {};
  for (const g of grants) {
    if (!live.has(g.stakeholderId)) continue;
    out[g.documentId] = (out[g.documentId] ?? 0) + 1;
  }
  return out;
}

const DocumentsPage = async () => {
  const { allow } = await serverAccessControl();
  const session = await withServerComponentSession();

  const documents = await allow(api.document.getAll(), ["documents", "read"]);

  const canUpload = allow(true, ["documents", "read"]);

  if (!documents) {
    return <UnAuthorizedState />;
  }

  // The investor portal exists only for an LLC and a role with `portal:
  // read`; otherwise its column and actions are absent (P29).
  const entity = await getSessionEntity();
  let portal: DocumentsPortalProps | null = null;
  if (entity.isLlc && allow(true, ["portal", "read"], false)) {
    const { companyId } = await checkMembership({ session, tx: db });
    portal = {
      sharedCounts: await sharedCounts(companyId),
      canShare: allow(true, ["portal", "create"], false) === true,
      canRemove: allow(true, ["portal", "delete"], false) === true,
      mailDelivery: currentMailDelivery("MEMBER_EMAIL"),
    };
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        icon={<RiUploadCloudLine />}
        title="You do not have any documents!"
        subtitle="Please click the button below to upload a new document."
      >
        {canUpload && (
          <DocumentUploadButton
            companyPublicId={session.user.companyPublicId}
            buttonDisplayName="Upload a document"
          />
        )}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-y-3">
      <PageLayout
        title="All documents"
        description="Upload documents to your company's document library."
        action={
          canUpload ? (
            <DocumentUploadButton
              companyPublicId={session.user.companyPublicId}
              buttonDisplayName="Document"
            />
          ) : null
        }
      />
      <Card className="mt-3">
        <div className="p-6">
          <DocumentsTable
            companyPublicId={session.user.companyPublicId}
            documents={documents}
            portal={portal}
          />
        </div>
      </Card>
    </div>
  );
};

export default DocumentsPage;
