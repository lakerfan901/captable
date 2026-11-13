"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { uploadFile } from "@/common/uploads";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TAG } from "@/lib/tags";
import { api } from "@/trpc/react";

// Upload an Exhibit B signature page as a subscription master (F12): the PDF
// goes to the private bucket the same way the e-sign "new document" modal
// does it (add-recepients-step.tsx), then `admission.createMaster` creates
// the master with its Investor and Manager placeholder recipients and the
// existing editor opens to place the fields.

const MAX_NAME = 120;

function nameFromFile(file: File): string {
  return file.name.replace(/\.pdf$/i, "").slice(0, MAX_NAME);
}

export function UploadMasterDialog({
  trigger,
  companyPublicId,
}: {
  trigger: React.ReactNode;
  companyPublicId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      setName("");
      setError(null);
    }
  }, [open]);

  const { mutateAsync: createBucket } = api.bucket.create.useMutation();
  const { mutateAsync: createMaster } =
    api.admission.createMaster.useMutation();

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    setError(null);
    if (picked && picked.type !== "application/pdf") {
      setFile(null);
      setError("Choose a PDF file.");
      return;
    }
    setFile(picked);
    if (picked && name.trim() === "") setName(nameFromFile(picked));
  }

  const trimmed = name.trim();
  const canSubmit = file !== null && trimmed.length > 0 && !busy;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { key, mimeType, size } = await uploadFile(file, {
        identifier: companyPublicId,
        keyPrefix: "unsigned-esign-doc",
      });
      const bucket = await createBucket({
        key,
        mimeType,
        name: trimmed,
        size,
        tags: [TAG.ESIGN],
      });
      const { publicId } = await createMaster({
        name: trimmed,
        bucketId: bucket.id,
      });
      toast.success("Master uploaded. Place the fields next.");
      setOpen(false);
      router.push(`/${companyPublicId}/documents/esign/${publicId}`);
    } catch (e) {
      const message =
        e instanceof Error && e.message
          ? e.message
          : "The master could not be uploaded.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload master</DialogTitle>
          <DialogDescription>
            Upload the Exhibit B signature page once and send it to every
            investor.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="masterFile">PDF</Label>
            <Input
              id="masterFile"
              type="file"
              accept="application/pdf"
              onChange={onFileChange}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="masterName">Name</Label>
            <Input
              id="masterName"
              value={name}
              maxLength={MAX_NAME}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Place one field per Exhibit B blank and choose its meaning. To let a
            different Manager signatory sign on their own line, keep one master
            per signatory.
          </p>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" loading={busy} disabled={!canSubmit}>
              Upload and place fields
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
