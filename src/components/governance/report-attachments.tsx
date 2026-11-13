"use client";

import { createTRPCClient, httpLink } from "@trpc/client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { uploadFile } from "@/common/uploads";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TAG } from "@/lib/tags";
import type { AppRouter } from "@/trpc/api/root";
import { api } from "@/trpc/react";
import type { MemberReportAttachmentKind } from "@/trpc/routers/member-report-router/schema";
import { getUrl, type RouterOutputs, transformer } from "@/trpc/shared";

// Report attachments (03-governance.md G13).
//
// Manager side: upload (browser `uploadFile` into the company namespace,
// then `bucket.create`, then `memberReport.addAttachment`), list, open and
// remove. On a TAX_K1 report every file is private to one holder (the server
// refuses shared files there), so only the per-holder K-1 table is offered.
//
// Public side (`PublicReportDocuments`, `MarkReportViewed`): the token is a
// credential. These calls use a private tRPC client with no logger link and
// no batching, like the public ballot page; every public report procedure is
// a mutation, so the token travels in the POST body only. Only the files
// `memberReportView.view` returned are listed: never another holder's file.

type Get = RouterOutputs["memberReport"]["get"];
type Attachment = Get["attachments"][number];
type Candidate = Get["candidates"][number];

const KIND_LABEL: Record<string, string> = {
  GENERAL: "General",
  BALANCE_SHEET: "Balance sheet",
  INCOME_STATEMENT: "Income statement",
  K1: "Schedule K-1",
};

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Upload one file to a new private bucket; returns the bucket. */
function useBucketUpload(companyPublicId: string) {
  const createBucket = api.bucket.create.useMutation();
  return async (file: File) => {
    const { key, mimeType, name, size } = await uploadFile(file, {
      identifier: companyPublicId,
      keyPrefix: "generic-documents",
    });
    return await createBucket.mutateAsync({
      key,
      mimeType,
      name,
      size,
      // Uploaded files are not generated records (G18 reads MEMBER_REPORT
      // as "generated").
      tags: [TAG.GENERIC],
    });
  };
}

function FilePickButton({
  label,
  busyLabel,
  disabled,
  onFile,
  size = "sm",
  variant = "outline",
}: {
  label: string;
  busyLabel: string;
  disabled?: boolean;
  onFile: (file: File) => Promise<void>;
  size?: "sm" | "default";
  variant?: "outline" | "default";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={input}
        type="file"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            await onFile(file);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button
        type="button"
        size={size}
        variant={variant}
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        {busy ? busyLabel : label}
      </Button>
    </>
  );
}

export function ReportAttachments({
  publicId,
  companyPublicId,
  type,
  status,
  attachments,
  candidates,
  canUpdate,
}: {
  publicId: string;
  companyPublicId: string;
  type: string;
  status: string;
  attachments: Attachment[];
  candidates: Candidate[];
  canUpdate: boolean;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const upload = useBucketUpload(companyPublicId);
  const add = api.memberReport.addAttachment.useMutation();
  const remove = api.memberReport.removeAttachment.useMutation();
  const isDraft = status === "DRAFT";
  const kinds: MemberReportAttachmentKind[] =
    type === "ANNUAL"
      ? ["GENERAL", "BALANCE_SHEET", "INCOME_STATEMENT"]
      : ["GENERAL"];
  const [kind, setKind] = useState<MemberReportAttachmentKind>(
    kinds[0] ?? "GENERAL",
  );

  const attach = async (
    file: File,
    k: MemberReportAttachmentKind,
    stakeholderId?: string,
  ) => {
    try {
      const bucket = await upload(file);
      await add.mutateAsync({
        publicId,
        bucketId: bucket.id,
        name: bucket.name.slice(0, 200),
        kind: k,
        ...(stakeholderId ? { stakeholderId } : {}),
      });
      toast.success("File attached.");
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The file could not be attached."));
    }
  };

  const open = async (attachmentId: string, inline: boolean) => {
    // A PDF or image opens in a new tab (opened inside the click so popup
    // blockers allow it); any other file is served as a download and fetched
    // in place, so no blank tab is left behind.
    const tab = inline ? window.open("", "_blank") : null;
    try {
      const { url } = await utils.memberReport.attachmentUrl.fetch({
        publicId,
        attachmentId,
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch (e) {
      tab?.close();
      toast.error(errorText(e, "The file could not be opened."));
    }
  };

  const onRemove = async (attachmentId: string) => {
    try {
      await remove.mutateAsync({ publicId, attachmentId });
      toast.success("File removed.");
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The file could not be removed."));
    }
  };

  const fileList = (list: Attachment[]) =>
    list.length === 0 ? null : (
      <ul className="space-y-1 text-sm">
        {list.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="break-all text-left underline"
              onClick={() => void open(a.id, a.inline)}
            >
              {a.name}
            </button>
            <Badge variant="secondary">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
            {a.stakeholderId ? (
              <span className="text-xs text-muted-foreground">
                Only for {a.holderName ?? "one holder"}
              </span>
            ) : null}
            {isDraft && canUpdate ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => void onRemove(a.id)}
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    );

  if (type === "TAX_K1") {
    const byHolder = new Map<string, Attachment[]>();
    for (const a of attachments) {
      if (!a.stakeholderId) continue;
      byHolder.set(a.stakeholderId, [
        ...(byHolder.get(a.stakeholderId) ?? []),
        a,
      ]);
    }
    if (!isDraft) {
      return attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files.</p>
      ) : (
        fileList(attachments)
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Each Schedule K-1 is private: only the holder it is attached to can
          see it.
        </p>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Member or holder of a Financial Interest.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Holder</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Schedule K-1</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => (
                <TableRow key={c.stakeholderId}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        c.memberStatus === "MEMBER" ? "success" : "secondary"
                      }
                    >
                      {c.memberStatus === "MEMBER"
                        ? "Member"
                        : "Financial Interest only"}
                    </Badge>
                  </TableCell>
                  <TableCell className="space-y-2">
                    {fileList(byHolder.get(c.stakeholderId) ?? [])}
                    {canUpdate ? (
                      <FilePickButton
                        label={
                          byHolder.has(c.stakeholderId)
                            ? "Upload another"
                            : "Upload K-1"
                        }
                        busyLabel="Uploading…"
                        onFile={(file) => attach(file, "K1", c.stakeholderId)}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files attached.</p>
      ) : (
        fileList(attachments)
      )}
      {canUpdate ? (
        <div className="flex flex-wrap items-end gap-2">
          {kinds.length > 1 ? (
            <div className="space-y-1">
              <Label className="text-xs">Kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as MemberReportAttachmentKind)}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <FilePickButton
            label={isDraft ? "Upload a file" : "Add a file"}
            busyLabel="Uploading…"
            onFile={(file) => attach(file, kind)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Opens the filed PDF (a Document of the company). */
export function FiledDocumentButton({
  documentPublicId,
}: {
  documentPublicId: string;
}) {
  const utils = api.useUtils();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const tab = window.open("", "_blank");
        try {
          const res = await utils.document.get.fetch({
            publicId: documentPublicId,
          });
          if (tab) {
            tab.opener = null;
            tab.location.href = res.url;
          } else {
            window.location.assign(res.url);
          }
        } catch (e) {
          tab?.close();
          toast.error(errorText(e, "Could not open the document."));
        } finally {
          setBusy(false);
        }
      }}
    >
      Filed PDF
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Public page pieces

let publicClient: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;
function client() {
  if (publicClient === null) {
    publicClient = createTRPCClient<AppRouter>({
      links: [httpLink({ url: getUrl(), transformer })],
    });
  }
  return publicClient;
}

/** Records the view once (the ref also absorbs React's dev double effect). */
export function MarkReportViewed({ token }: { token: string }) {
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    client()
      .memberReportView.markViewed.mutate({ token })
      .catch(() => {
        // Viewing evidence is best effort; the page works without it.
      });
  }, [token]);
  return null;
}

export function PublicReportDocuments({
  token,
  attachments,
}: {
  token: string;
  attachments: {
    id: string;
    name: string;
    kind: string;
    private: boolean;
    /** PDF or image (opens in a tab); otherwise downloaded. */
    inline: boolean;
  }[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (attachments.length === 0) return null;

  const openFile = async (attachmentId: string, inline: boolean) => {
    setError(null);
    setBusy(attachmentId);
    // A PDF or image: open the tab inside the click (an `await` first would
    // be blocked as a popup on mobile browsers); it is pointed at the file
    // once we have it. Any other file is served as a download: no tab.
    const tab = inline ? window.open("", "_blank") : null;
    try {
      const { url } = await client().memberReportView.attachmentUrl.mutate({
        token,
        attachmentId,
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch {
      tab?.close();
      setError("The file could not be opened. Reload the page and try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Documents</h2>
      <ul className="space-y-2">
        {attachments.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-w-full justify-start truncate"
              disabled={busy === a.id}
              onClick={() => void openFile(a.id, a.inline)}
            >
              {busy === a.id ? "Opening…" : a.name}
            </Button>
            {a.private ? (
              <span className="text-xs text-muted-foreground">
                Only visible to you
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
