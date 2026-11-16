import FileIcon from "@/components/common/file-icon";
import { iconTypeHint, splitAttachments } from "@/lib/portal/portal-files-view";
import { PortalFileButton } from "./file-button";

// The files of a report in the portal (04-investor-portal.md 6.1, P12;
// approved prototype; package P8b): "Your documents" for files private to
// this holder (a K-1) and "Attachments" for files shared with every
// recipient. Only the files `portal.reports.get` returned are listed, so
// another holder's K-1 is never on the page. A list with no file is not
// shown at all. Each file opens through `PortalFileButton`.

export interface PortalReportFile {
  id: string;
  name: string;
  private: boolean;
  inline: boolean;
}

function FileList(props: {
  access: string;
  reportId: string;
  files: PortalReportFile[];
  note: string;
  testId: string;
}) {
  return (
    <ul className="divide-y rounded-md border" data-testid={props.testId}>
      {props.files.map((f) => (
        <li
          key={f.id}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0" aria-hidden>
              <FileIcon type={iconTypeHint(f.name)} />
            </span>
            <PortalFileButton
              access={props.access}
              target={{
                kind: "report",
                reportId: props.reportId,
                attachmentId: f.id,
              }}
              name={f.name}
              inline={f.inline}
              note={props.note}
              variant="link"
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {f.inline ? "Opens here" : "Downloads"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PortalReportFiles(props: {
  access: string;
  reportId: string;
  files: PortalReportFile[];
}) {
  const { own, shared } = splitAttachments(props.files);
  return (
    <>
      {own.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Your documents</h2>
          <FileList
            access={props.access}
            reportId={props.reportId}
            files={own}
            note="Your document. Only you can open it."
            testId="report-own-files"
          />
        </section>
      ) : null}
      {shared.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Attachments</h2>
          <FileList
            access={props.access}
            reportId={props.reportId}
            files={shared}
            note="Attachment of the report."
            testId="report-shared-files"
          />
        </section>
      ) : null}
    </>
  );
}
