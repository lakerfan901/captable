"use client";

import { toast } from "sonner";
import { InstantTime } from "@/components/common/instant-time";
import { Allow } from "@/components/rbac/allow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getPresignedGetUrl } from "@/server/file-upload-actions";
import type { RouterOutputs } from "@/trpc/shared";
import {
  AttachDocumentDialog,
  DOCUMENT_KIND_LABELS,
} from "./attach-document-dialog";

type MemberDocuments = RouterOutputs["stakeholder"]["memberDocuments"];

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const kindLabel = (kind: string | null) =>
  kind && kind in DOCUMENT_KIND_LABELS
    ? DOCUMENT_KIND_LABELS[kind as keyof typeof DOCUMENT_KIND_LABELS]
    : (kind ?? "—");

export function MemberDocumentsTab({
  stakeholderId,
  documents,
}: {
  stakeholderId: string;
  documents: MemberDocuments;
}) {
  const openFile = async (key: string) => {
    try {
      const file = await getPresignedGetUrl(key);
      window.open(file.url, "_blank");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open the file.",
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Allow subject="stakeholder" action="update">
          <Allow subject="documents" action="create">
            <AttachDocumentDialog stakeholderId={stakeholderId} />
          </Allow>
        </Allow>
      </div>
      <Card>
        {documents.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No documents attached to this member.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead>Size</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.name}</TableCell>
                  <TableCell>{kindLabel(doc.kind)}</TableCell>
                  <TableCell>
                    <InstantTime at={doc.createdAt} dateOnly />
                  </TableCell>
                  <TableCell>{formatSize(doc.bucket.size)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openFile(doc.bucket.key)}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
