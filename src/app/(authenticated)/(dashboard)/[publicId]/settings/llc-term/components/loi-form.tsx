"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/trpc/react";

const NONE = "__none__";

export function LoiForm({
  days,
  loiDocumentId,
  maxDays,
  hasOcd,
  documents,
  canEdit,
}: {
  days: number;
  loiDocumentId: string | null;
  maxDays: number;
  hasOcd: boolean;
  documents: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(days));
  const [documentId, setDocumentId] = useState(loiDocumentId ?? NONE);
  const mutation = api.llcTerm.setLoiExtension.useMutation({
    onSuccess: () => {
      toast.success("LOI extension saved.");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= maxDays;
  const needsDocument = parsed > 0 && documentId === NONE;
  const disabled = !canEdit || !hasOcd;
  // The current document may not be in the list (e.g. no documents permission).
  const options =
    loiDocumentId !== null && !documents.some((d) => d.id === loiDocumentId)
      ? [...documents, { id: loiDocumentId, name: "Current document" }]
      : documents;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">LOI extension</CardTitle>
        <CardDescription>
          Section 2.4: if a signed letter of intent or purchase agreement is in
          effect on the Target Sale Date, the Target Sale Date extends by up to{" "}
          {maxDays} days.
          {hasOcd ? "" : " Set the Operations Commencement Date first."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate({
              days: parsed,
              loiDocumentId: documentId === NONE ? null : documentId,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="loi-days">Extension (days)</Label>
            <Input
              id="loi-days"
              type="number"
              min={0}
              max={maxDays}
              step={1}
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            />
            {valid ? null : (
              <p className="text-sm text-destructive">
                Enter whole days from 0 to {maxDays}.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Signed LOI or purchase agreement</Label>
            <Select
              value={documentId}
              onValueChange={setDocumentId}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a document" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {options.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {needsDocument ? (
              <p className="text-sm text-destructive">
                An extension needs the signed document. Upload it in Documents
                first.
              </p>
            ) : null}
          </div>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                disabled || !valid || needsDocument || mutation.isPending
              }
              loading={mutation.isPending}
            >
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
