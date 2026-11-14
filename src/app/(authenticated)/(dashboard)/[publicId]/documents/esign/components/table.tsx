import Link from "next/link";
import FileIcon from "@/components/common/file-icon";
import { InstantTime } from "@/components/common/instant-time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";
import { TemplateCancelButton } from "./temp-cancel-btx";

type DocumentsType = RouterOutputs["template"]["all"]["documents"];

type ESignTableProps = {
  documents: DocumentsType;
  companyPublicId: string;
};

export const ESignTable = ({ documents, companyPublicId }: ESignTableProps) => {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Signed Status</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <Link
                href={`/${companyPublicId}/documents/esign/v/${item.publicId}`}
                className="flex items-center hover:underline"
              >
                <span className="mr-3">
                  <FileIcon type={"application/pdf"} />
                </span>
                <span className="flex">{item.name}</span>
              </Link>
            </TableCell>

            <TableCell>
              {item.isMaster ? (
                <Badge variant="info">Master</Badge>
              ) : (
                item.status
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <InstantTime at={item.createdAt} dateOnly />
            </TableCell>

            <TableCell>{item.completedOn ? "Signed" : "Not Signed"}</TableCell>

            <TableCell className="flex gap-x-2">
              <Link
                className={buttonVariants()}
                href={`/${companyPublicId}/documents/esign/v/${item.publicId}`}
              >
                View
              </Link>

              {item.status === "DRAFT" && (
                <Link
                  className={buttonVariants()}
                  href={`/${companyPublicId}/documents/esign/${item.publicId}`}
                >
                  Edit
                </Link>
              )}

              {!item.isMaster && (
                <TemplateCancelButton
                  templateId={item.id}
                  publicId={item.publicId}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
