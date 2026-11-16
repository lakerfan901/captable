"use client";

import { RiMore2Fill } from "@remixicon/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import FileIcon from "@/components/common/file-icon";
import { InstantTime } from "@/components/common/instant-time";
import { ShareWithInvestorsDialog } from "@/components/llc/portal/share-with-investors-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MailDeliveryState } from "@/lib/mail-delivery";
import {
  SHARE_DOCUMENTS_MAX,
  sharedWithLabel,
} from "@/lib/portal/share-dialog-view";
import { getPresignedGetUrl } from "@/server/file-upload-actions";
import type { RouterOutputs } from "@/trpc/shared";

type DocumentType = RouterOutputs["document"]["getAll"];

/**
 * The investor portal on this table (04-investor-portal.md 6.2; package
 * P9a). `null` for a corporation or a role without `portal: read`: then no
 * column, no tick box and no share action exist at all (P29).
 */
export type DocumentsPortalProps = {
  /** Holders on each document's share list, by `Document.id`. */
  sharedCounts: Record<string, number>;
  /** `portal: create`: row tick boxes and "Share with investors". */
  canShare: boolean;
  /** `portal: delete`: "Remove" in the dialog. */
  canRemove: boolean;
  mailDelivery: MailDeliveryState;
};

type DocumentTableProps = {
  documents: DocumentType;
  companyPublicId: string;
  portal?: DocumentsPortalProps | null;
};

/**
 * Whose document it is: the member it is filed on, else the team member who
 * uploaded it, else the company (a file the app generated: a signed packet,
 * a report, a resolution).
 */
function ownerOf(document: DocumentType[number]): string {
  return (
    document.stakeholder?.name ??
    document.uploader?.user?.name ??
    "Company (generated)"
  );
}

const DocumentsTable = ({
  documents,
  companyPublicId,
  portal = null,
}: DocumentTableProps) => {
  const router = useRouter();
  const openFileOnTab = async (key: string) => {
    const fileUrl = await getPresignedGetUrl(key);
    window.open(fileUrl.url, "_blank");
  };
  const canShare = portal?.canShare === true;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sharing, setSharing] = useState<string[] | null>(null);
  const selectedIds = documents
    .filter((d) => selected.has(d.publicId))
    .map((d) => d.publicId);
  const atCap = selectedIds.length >= SHARE_DOCUMENTS_MAX;
  const toggle = (publicId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(publicId);
    else next.delete(publicId);
    setSelected(next);
  };
  const countOf = (id: string) => portal?.sharedCounts[id] ?? 0;

  return (
    <Card>
      {canShare && selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3 text-sm">
          <span>
            {selectedIds.length} selected
            {atCap ? ` (at most ${SHARE_DOCUMENTS_MAX} at a time)` : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSharing(selectedIds)}
            >
              Share with investors ({selectedIds.length})
            </Button>
          </div>
        </div>
      ) : null}
      <Table className="">
        <TableHeader>
          <TableRow>
            {canShare && (
              <TableHead className="w-8">
                <span className="sr-only">Select</span>
              </TableHead>
            )}
            <TableHead>Name</TableHead>
            {/* <TableHead>Type</TableHead> */}
            <TableHead>Owner</TableHead>
            <TableHead>Uploaded</TableHead>
            {portal && <TableHead>Shared with</TableHead>}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((document) => (
            <TableRow
              key={document.id}
              data-state={
                canShare && selected.has(document.publicId)
                  ? "selected"
                  : undefined
              }
            >
              {canShare && (
                <TableCell>
                  <Checkbox
                    aria-label={`Select ${document.name}`}
                    checked={selected.has(document.publicId)}
                    disabled={atCap && !selected.has(document.publicId)}
                    onCheckedChange={(c) =>
                      toggle(document.publicId, c === true)
                    }
                  />
                </TableCell>
              )}
              <TableCell>
                <Link
                  href={`/${companyPublicId}/documents/${document.bucket.id}`}
                  className="flex items-center hover:underline"
                >
                  <span className="mr-3">
                    <FileIcon type={document.bucket.mimeType} />
                  </span>
                  <span className="flex">{document.name}</span>
                </Link>
              </TableCell>
              <TableCell>{ownerOf(document)}</TableCell>
              <TableCell className="whitespace-nowrap">
                <InstantTime at={document.createdAt} dateOnly />
              </TableCell>
              {portal && (
                <TableCell className="whitespace-nowrap">
                  {canShare && countOf(document.id) > 0 ? (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => setSharing([document.publicId])}
                    >
                      {sharedWithLabel(countOf(document.id))}
                    </button>
                  ) : (
                    sharedWithLabel(countOf(document.id))
                  )}
                </TableCell>
              )}

              <TableCell>
                <div className="flex items-center gap-4">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Options for ${document.name}`}
                    >
                      <RiMore2Fill className="cursor-pointer text-muted-foreground hover:text-primary/80" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuLabel>Options</DropdownMenuLabel>
                      <DropdownMenuSeparator />

                      <DropdownMenuItem
                        onClick={() => {
                          router.push(
                            `/${companyPublicId}/documents/${document.bucket.id}`,
                          );
                        }}
                      >
                        View
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={async () => {
                          await openFileOnTab(document.bucket.key);
                        }}
                      >
                        Download
                      </DropdownMenuItem>
                      {canShare && (
                        <DropdownMenuItem
                          onClick={() => setSharing([document.publicId])}
                        >
                          Share with investors
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {portal && sharing ? (
        <ShareWithInvestorsDialog
          documentPublicIds={sharing}
          canRemove={portal.canRemove}
          mailDelivery={portal.mailDelivery}
          onClose={() => setSharing(null)}
          onSaved={() => {
            setSharing(null);
            setSelected(new Set());
            router.refresh();
          }}
        />
      ) : null}
    </Card>
  );
};

export default DocumentsTable;
