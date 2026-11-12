"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TAG } from "@/lib/tags";
import { api } from "@/trpc/react";
import { MEMBER_DOCUMENT_KINDS } from "@/trpc/routers/stakeholder-router/member-schema";

type Kind = (typeof MEMBER_DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<Kind, string> = {
  "exhibit-b": "Exhibit B (signature page)",
  w9: "W-9",
  "wire-confirmation": "Wire confirmation",
  other: "Other",
};

export function AttachDocumentDialog({
  stakeholderId,
}: {
  stakeholderId: string;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("other");
  const [pending, setPending] = useState(false);

  const { mutateAsync: createBucket } = api.bucket.create.useMutation();
  const { mutateAsync: attachDocument } =
    api.stakeholder.attachDocument.useMutation();

  const reset = () => {
    setFile(null);
    setName("");
    setKind("other");
  };

  const onSubmit = async () => {
    if (!file || !session) return;
    setPending(true);
    try {
      const upload = await uploadFile(file, {
        identifier: session.user.companyPublicId,
        keyPrefix: "generic-documents",
      });
      const bucket = await createBucket({
        key: upload.key,
        mimeType: upload.mimeType,
        name: upload.name,
        size: upload.size,
        tags: [TAG.GENERIC],
      });
      await attachDocument({
        stakeholderId,
        bucketId: bucket.id,
        name: name.trim() || file.name,
        kind,
      });
      toast.success("Document attached.");
      setOpen(false);
      reset();
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to attach document.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Attach document</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach document</DialogTitle>
          <DialogDescription>
            Upload a file and attach it to this member.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="member-doc-file">File</Label>
            <Input
              id="member-doc-file"
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !name) setName(f.name);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="member-doc-name">Name</Label>
            <Input
              id="member-doc-name"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMBER_DOCUMENT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {DOCUMENT_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!file || pending}
            loading={pending}
            onClick={onSubmit}
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
