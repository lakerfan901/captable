"use client";

import { RiCheckboxCircleLine, RiFileUploadLine } from "@remixicon/react";
import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";

// Public Form W-9 upload (01-foundation.md F12). The link token is the only
// credential: it is sent in the body of the three public MUTATIONS (never a
// URL query), never rendered, logged or stored. The file goes straight to the
// private bucket through a presigned PUT whose Content-Type and
// Content-Length are signed, so the browser must send exactly the type and
// size it announced. The file's own name is not sent to the server. No link
// to the stored file is ever shown.

// The server's limits (server/llc/admission.ts), repeated here because that
// module is server-only. The server checks them again.
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
type AllowedType = (typeof ALLOWED_TYPES)[number];

const FILE_REFUSED = "The file must be a PDF, JPEG or PNG of at most 10 MB.";
const LIMIT_REACHED =
  "The maximum number of uploads was reached. Email the Manager.";
const UPLOAD_FAILED = "The upload failed. Please try again.";

function isAllowedType(type: string): type is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(type);
}

/** PUT with upload progress (fetch has none). Resolves on 2xx; never exposes the response body. */
function putFile(
  url: string,
  file: File,
  contentType: AllowedType,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(UPLOAD_FAILED));
    };
    xhr.onerror = () => reject(new Error(UPLOAD_FAILED));
    xhr.onabort = () => reject(new Error(UPLOAD_FAILED));
    xhr.send(file);
  });
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number }
  | { kind: "done" };

export function W9Upload({
  token,
  companyName,
  investorName,
  uploaded: initialUploaded,
  remaining: initialRemaining,
}: {
  token: string;
  companyName: string;
  investorName: string;
  uploaded: number;
  remaining: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [uploaded, setUploaded] = useState(initialUploaded);
  const [remaining, setRemaining] = useState(initialRemaining);

  const uploadUrl = api.admission.w9UploadUrl.useMutation();
  const complete = api.admission.w9Complete.useMutation();

  const busy = phase.kind === "uploading";

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    setError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    if (
      !isAllowedType(picked.type) ||
      picked.size < 1 ||
      picked.size > MAX_BYTES
    ) {
      setFile(null);
      setError(FILE_REFUSED);
      event.target.value = "";
      return;
    }
    setFile(picked);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || busy || remaining <= 0) return;
    const contentType = file.type;
    if (!isAllowedType(contentType) || file.size < 1 || file.size > MAX_BYTES) {
      setError(FILE_REFUSED);
      return;
    }
    setError(null);
    setPhase({ kind: "uploading", percent: 0 });
    try {
      const { url, key } = await uploadUrl.mutateAsync({
        token,
        // The server ignores the name; the investor's file name is not sent.
        fileName: "w9",
        contentType,
        size: file.size,
      });
      await putFile(url, file, contentType, (percent) =>
        setPhase({ kind: "uploading", percent }),
      );
      await complete.mutateAsync({ token, key });
      setUploaded((n) => n + 1);
      setRemaining((n) => Math.max(0, n - 1));
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setPhase({ kind: "done" });
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : null;
      setError(message ?? UPLOAD_FAILED);
      setPhase({ kind: "idle" });
      if (message === LIMIT_REACHED) setRemaining(0);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Upload your Form W-9
        </h1>
        <p className="text-sm text-muted-foreground">
          {companyName} · for {investorName}
        </p>
      </div>

      <p className="text-base">
        Upload your completed IRS Form W-9 (PDF, JPEG or PNG, up to 10 MB). It
        is stored privately and is visible only to the Manager.
      </p>

      {phase.kind === "done" ? (
        <Alert>
          <RiCheckboxCircleLine className="h-4 w-4 text-green-600" />
          <AlertDescription>
            Thank you, your Form W-9 was received. You can close this page.
            {remaining > 0
              ? ` If you need to send a corrected form, you can upload ${remaining} more ${remaining === 1 ? "file" : "files"}.`
              : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {remaining <= 0 ? (
        phase.kind === "done" ? null : (
          <Alert variant="destructive">
            <AlertDescription>{LIMIT_REACHED}</AlertDescription>
          </Alert>
        )
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="w9File">Form W-9</Label>
            <Input
              ref={inputRef}
              id="w9File"
              type="file"
              accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
              onChange={onFileChange}
              disabled={busy}
            />
            {uploaded > 0 && phase.kind !== "done" ? (
              <p className="text-xs text-muted-foreground">
                {uploaded} {uploaded === 1 ? "file" : "files"} already received.
                {` ${remaining} more ${remaining === 1 ? "upload is" : "uploads are"} allowed.`}
              </p>
            ) : null}
          </div>

          {phase.kind === "uploading" ? (
            <div className="space-y-1">
              <div
                className="h-2 w-full overflow-hidden rounded bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={phase.percent}
                aria-label="Upload progress"
              >
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${phase.percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Uploading… {phase.percent}%
              </p>
            </div>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div>
            <Button type="submit" disabled={!file || busy} loading={busy}>
              <RiFileUploadLine className="mr-2 h-4 w-4" />
              Upload
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
