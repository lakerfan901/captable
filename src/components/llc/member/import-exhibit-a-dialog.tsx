"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { exhibitATemplateCsv } from "@/lib/admission/exhibit-a-csv";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { api } from "@/trpc/react";
import type { ExhibitAImportResult } from "@/trpc/routers/stakeholder-router/procedures/import-exhibit-a";

const trimUnits = (u: string) => u.replace(/\.?0+$/, "");

function downloadTemplate() {
  const blob = new Blob([exhibitATemplateCsv()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "exhibit-a-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportExhibitADialog({ trigger }: { trigger: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<ExhibitAImportResult | null>(null);

  const mutation = api.stakeholder.importExhibitA.useMutation();

  const changeText = (text: string) => {
    setCsvText(text);
    setPreview(null); // never import against a stale preview
  };

  const check = () => {
    mutation.mutate(
      { csvText, dryRun: true },
      {
        onSuccess: (result) => setPreview(result),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  const runImport = () => {
    mutation.mutate(
      { csvText, dryRun: false },
      {
        onSuccess: (result) => {
          toast.success(`Imported ${result.rows.length} members.`);
          setOpen(false);
          changeText("");
          router.refresh();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) changeText("");
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import Exhibit A</DialogTitle>
          <DialogDescription>
            Record members admitted on paper. Every row is checked with the same
            rules as manual entry; if any row has an error nothing is imported.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="exhibit-a-file">CSV file</Label>
              <Input
                id="exhibit-a-file"
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) changeText(await file.text());
                }}
              />
            </div>
            <Button type="button" variant="outline" onClick={downloadTemplate}>
              Download template
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="exhibit-a-text">Or paste the CSV</Label>
            <Textarea
              id="exhibit-a-text"
              rows={6}
              className="font-mono text-xs"
              value={csvText}
              onChange={(e) => changeText(e.target.value)}
            />
          </div>
        </div>

        {preview && (
          <div className="flex flex-col gap-2">
            {preview.fileErrors.length > 0 && (
              <ul className="text-sm text-red-600">
                {preview.fileErrors.map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    Line {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            )}
            {preview.rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead>Member</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Committed</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead>Admitted</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.line}>
                      <TableCell>{r.line}</TableCell>
                      <TableCell>
                        {r.name}
                        {r.errors.map((e) => (
                          <p key={e} className="text-xs text-red-600">
                            {e}
                          </p>
                        ))}
                        {r.changes.map((c) => (
                          <p key={c} className="text-xs text-muted-foreground">
                            {c}
                          </p>
                        ))}
                      </TableCell>
                      <TableCell>{r.email}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(r.committedCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(r.paidCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {trimUnits(r.units)}
                      </TableCell>
                      <TableCell>{formatDateOnly(r.admittedOn)}</TableCell>
                      <TableCell>
                        {r.action === "create"
                          ? "New member"
                          : "Existing member"}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={3} className="font-medium">
                      Total
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(preview.totals.committedCents)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(preview.totals.paidCents)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {trimUnits(preview.totals.units)}
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableBody>
              </Table>
            )}
            <p className="text-xs text-muted-foreground">
              Receipt date defaults to the admission date; the Preferred Return
              starts on the receipt date. Correct individual receipts afterwards
              if the wire arrived on a different day.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending || csvText.trim() === ""}
            loading={mutation.isPending && !preview}
            onClick={check}
          >
            Check
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || !preview?.canImport}
            loading={mutation.isPending && !!preview}
            onClick={runImport}
          >
            Import {preview?.rows.length ?? 0} members
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
