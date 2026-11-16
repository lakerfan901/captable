"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { downloadBytes } from "@/components/common/download-bytes";
import { PdfPreview } from "@/components/file/pdf-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fileOpenMode,
  refusalAction,
  trpcErrorCode,
  type ViewerKind,
  viewerKind,
} from "@/lib/portal/portal-files-view";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";

// Opening a file in the investor portal (04-investor-portal.md 6.1, P16,
// S19; approved prototype; package P8b).
//
// The short-lived storage URL is requested at click time by a browser
// mutation (`portal.reports.fileUrl` / `portal.documents.fileUrl`), so the
// access log stores the client's address (2.2) and the URL is never in the
// page HTML, a page URL or a cache. Every click asks for a new URL: one that
// has expired is never reused.
//
// A PDF or image (`inline`) opens in the viewer dialog. The bytes are fetched
// once from the storage origin (CSP `connect-src`) and kept in memory while
// the dialog is open: the PDF is drawn by pdf.js (`PdfPreview`, the same
// viewer as the team side; its worker is same-origin), an image from a
// `blob:` URL (`img-src blob:`). "Download" saves those same bytes through a
// `blob:` link, so it needs no second URL. Any other file is served by the
// storage with `Content-Disposition: attachment`: the browser saves it and
// the page stays where it is.
//
// A refusal that means the item or the access is gone (unpublished,
// unshared, recipient removed, access turned off, signed out) re-renders the
// page from the server, which then shows the portal's "not available" page,
// the shorter list, `/portal` or sign-in (`refusalAction`).

export type PortalFileTarget =
  | { kind: "document"; documentId: string }
  | { kind: "report"; reportId: string; attachmentId: string };

export interface PortalFileButtonProps {
  /** `PortalAccess.publicId` of the page. */
  access: string;
  target: PortalFileTarget;
  /** The file name: the viewer's title and the saved file's name. */
  name: string;
  /** PDF or raster image: viewer; anything else: download. */
  inline: boolean;
  /** One line under the viewer's title ("Your document. Only you can open it."). */
  note?: string;
  /** `link`: the file name as a text link; `button`: an outline button. */
  variant?: "link" | "button";
  /** Text of a `button` (default "Open" or "Download"); a link shows `name`. */
  label?: string;
  className?: string;
}

interface Loaded {
  kind: ViewerKind;
  blob: Blob;
  /** `blob:` URL of an image, revoked when the viewer closes. */
  objectUrl: string | null;
  /** The PDF as a File for pdf.js. */
  file: File | null;
}

const GONE = "This file is no longer available.";
const FAILED = "The file could not be opened. Please try again.";

export function PortalFileButton(props: PortalFileButtonProps) {
  const router = useRouter();
  const reportUrl = api.portal.reports.fileUrl.useMutation();
  const documentUrl = api.portal.documents.fileUrl.useMutation();
  const mode = fileOpenMode(props.inline);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  // The latest request wins; a closed viewer ignores a late answer.
  const attempt = useRef(0);
  // The viewer is opened by a plain button (it fetches first), so focus is
  // handed back to that button by hand when the dialog closes.
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return () => {
      if (loaded?.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
    };
  }, [loaded]);

  const requestUrl = async (): Promise<string> => {
    const t = props.target;
    const res =
      t.kind === "document"
        ? await documentUrl.mutateAsync({
            access: props.access,
            documentId: t.documentId,
          })
        : await reportUrl.mutateAsync({
            access: props.access,
            reportId: t.reportId,
            attachmentId: t.attachmentId,
          });
    return res.url;
  };

  // Every way of closing the viewer: drops the bytes (and the blob: URL,
  // through the effect above) and ignores a request still in flight.
  const closeViewer = () => {
    attempt.current++;
    setOpen(false);
    setBusy(false);
    setLoaded(null);
    setFailed(false);
  };

  const refused = (error: unknown): boolean => {
    if (refusalAction(trpcErrorCode(error)) !== "reload") return false;
    closeViewer();
    toast.error(GONE);
    router.refresh();
    return true;
  };

  const download = async () => {
    setBusy(true);
    try {
      const url = await requestUrl();
      // Served as an attachment: the browser saves it, the page stays.
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      if (!refused(error)) toast.error(FAILED);
    } finally {
      setBusy(false);
    }
  };

  const view = async () => {
    const mine = ++attempt.current;
    setLoaded(null);
    setFailed(false);
    setOpen(true);
    setBusy(true);
    try {
      const url = await requestUrl();
      const res = await fetch(url, {
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!res.ok) throw new Error(`storage ${res.status}`);
      const blob = await res.blob();
      if (mine !== attempt.current) return;
      const kind = viewerKind(blob.type || res.headers.get("content-type"));
      setLoaded({
        kind,
        blob,
        objectUrl: kind === "image" ? URL.createObjectURL(blob) : null,
        file:
          kind === "pdf"
            ? new File([blob], props.name, { type: "application/pdf" })
            : null,
      });
    } catch (error) {
      if (mine !== attempt.current) return;
      if (!refused(error)) setFailed(true);
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  };

  const saveLoaded = async () => {
    if (loaded === null) return;
    const bytes = new Uint8Array(await loaded.blob.arrayBuffer());
    downloadBytes(
      props.name,
      bytes,
      loaded.blob.type || "application/octet-stream",
    );
  };

  const onClick = () => void (mode === "view" ? view() : download());
  const busyText = mode === "view" ? "Opening…" : "Preparing…";

  const trigger =
    props.variant === "link" ? (
      <button
        ref={triggerRef}
        type="button"
        onClick={onClick}
        disabled={busy && mode === "download"}
        aria-haspopup={mode === "view" ? "dialog" : undefined}
        className={cn(
          "break-all rounded-sm text-left hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-70",
          props.className,
        )}
      >
        {props.name}
      </button>
    ) : (
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={busy}
        aria-haspopup={mode === "view" ? "dialog" : undefined}
        aria-label={`${props.label ?? (mode === "view" ? "Open" : "Download")} ${props.name}`}
        className={props.className}
      >
        {busy
          ? busyText
          : (props.label ?? (mode === "view" ? "Open" : "Download"))}
      </Button>
    );

  if (mode === "download") return trigger;

  return (
    <>
      {trigger}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else closeViewer();
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-3xl"
          data-testid="portal-file-viewer"
        >
          <DialogHeader>
            <DialogTitle className="break-all pr-12 leading-snug">
              {props.name}
            </DialogTitle>
            {props.note ? (
              <DialogDescription>{props.note}</DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                File viewer
              </DialogDescription>
            )}
          </DialogHeader>
          {/* The preview scrolls; title and buttons stay in view (a long PDF). */}
          <div
            className="max-h-[60vh] min-h-64 overflow-y-auto rounded-md border bg-muted"
            data-testid="viewer-body"
          >
            {loaded?.kind === "pdf" && loaded.file ? (
              <div className="bg-background" data-testid="viewer-pdf">
                <PdfPreview file={loaded.file} />
              </div>
            ) : loaded?.kind === "image" && loaded.objectUrl ? (
              // biome-ignore lint/performance/noImgElement: a blob: URL of a private file, next/image does not apply
              <img
                src={loaded.objectUrl}
                alt={props.name}
                className="mx-auto max-h-[58vh] w-auto rounded"
                data-testid="viewer-image"
              />
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-sm text-muted-foreground" role="status">
                  {failed
                    ? FAILED
                    : loaded
                      ? "This file cannot be shown here. Use Download to save it."
                      : "Opening…"}
                </p>
                {failed ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void view()}
                  >
                    Try again
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={closeViewer}>
              Close
            </Button>
            {/* Absent, not greyed, until the bytes are here. */}
            {loaded !== null ? (
              <Button
                type="button"
                onClick={() => void saveLoaded()}
                data-testid="viewer-download"
              >
                Download
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
