"use client";

import { RiMore2Fill } from "@remixicon/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FileIcon from "@/components/common/file-icon";
import { InstantTime } from "@/components/common/instant-time";
import { Card } from "@/components/ui/card";
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
import { getPresignedGetUrl } from "@/server/file-upload-actions";
import type { RouterOutputs } from "@/trpc/shared";

type DocumentType = RouterOutputs["document"]["getAll"];

type DocumentTableProps = {
  documents: DocumentType;
  companyPublicId: string;
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

const DocumentsTable = ({ documents, companyPublicId }: DocumentTableProps) => {
  const router = useRouter();
  const openFileOnTab = async (key: string) => {
    const fileUrl = await getPresignedGetUrl(key);
    window.open(fileUrl.url, "_blank");
  };

  return (
    <Card>
      <Table className="">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            {/* <TableHead>Type</TableHead> */}
            <TableHead>Owner</TableHead>
            <TableHead>Uploaded</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((document) => (
            <TableRow key={document.id}>
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

                      {/* <DropdownMenuItem
                          onClick={() => {
                            if (document) {
                              setSelectedDocumentId(document.id);
                            }
                            setOpenShareModal(true);
                          }}
                        >
                          Share document
                        </DropdownMenuItem> */}

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
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
};

export default DocumentsTable;
