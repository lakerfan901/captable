import FileIcon from "@/components/common/file-icon";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  categoryLabel,
  formatDay,
  formatFileSize,
  iconTypeHint,
} from "@/lib/portal/portal-files-view";
import { PortalFileButton } from "./file-button";

// The documents shared with one holder (04-investor-portal.md 6.1; approved
// prototype; package P8b): name, category, date shared, size and "Open"
// (a PDF or image, in the viewer) or "Download" (any other file). Server
// component; each row carries only the document's public id, name, category,
// date and size. The URL of the file is requested when the button is
// pressed (`PortalFileButton`), never rendered into the page.

export interface PortalDocumentRow {
  /** `Document.publicId`. */
  id: string;
  name: string;
  sharedAt: Date;
  inline: boolean;
  sizeBytes: number;
  category: string | null;
}

export function PortalDocumentList(props: {
  access: string;
  documents: PortalDocumentRow[];
  timeZone: string;
}) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="hidden md:table-cell">Category</TableHead>
            <TableHead className="hidden sm:table-cell">Date shared</TableHead>
            <TableHead className="hidden sm:table-cell">Size</TableHead>
            <TableHead>
              <span className="sr-only">Open</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.documents.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="h-24 text-center text-muted-foreground"
                id="documents-empty"
              >
                No documents have been shared with you yet.
              </TableCell>
            </TableRow>
          ) : (
            props.documents.map((d) => {
              const category = categoryLabel(d.category);
              const shared = formatDay(d.sharedAt, props.timeZone);
              const size = formatFileSize(d.sizeBytes);
              const note = [category, size].filter(Boolean).join(" · ");
              return (
                <TableRow key={d.id} data-testid="document-row">
                  <TableCell>
                    <div className="flex items-center">
                      <span className="mr-3 shrink-0" aria-hidden>
                        <FileIcon type={iconTypeHint(d.name)} />
                      </span>
                      <div className="min-w-0">
                        <span className="block break-words">{d.name}</span>
                        {/* On a phone the date and size ride under the name. */}
                        <span className="block text-xs text-muted-foreground sm:hidden">
                          {[shared, size].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {category}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap sm:table-cell">
                    {shared}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap sm:table-cell">
                    {size}
                  </TableCell>
                  <TableCell className="text-right">
                    <PortalFileButton
                      access={props.access}
                      target={{ kind: "document", documentId: d.id }}
                      name={d.name}
                      inline={d.inline}
                      note={note || undefined}
                    />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
