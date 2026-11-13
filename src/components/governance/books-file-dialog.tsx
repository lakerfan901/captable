"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type BooksCategory,
  booksCategoryDef,
  yearRequired,
} from "@/lib/governance/books-core";
import { api } from "@/trpc/react";

// "File a document" (03-governance.md G18): pick one of the company's
// uncategorised documents and file it under a Section 8.1 category, with the
// fiscal year where the category is kept per year. New files are uploaded on
// the Documents page first.

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function BooksFileDialog({
  category,
  defaultYear,
  documentsHref,
}: {
  category: BooksCategory;
  /** Preselected fiscal year (the first missing year, else last year). */
  defaultYear: number;
  documentsHref: string;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const def = booksCategoryDef(category);
  const needsYear = yearRequired(category);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [year, setYear] = useState(String(defaultYear));

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = api.books.uncategorized.useQuery(
    debounced ? { search: debounced } : {},
    { enabled: open },
  );
  const categorize = api.books.categorize.useMutation();

  const yearNumber = Number(year);
  const yearValid =
    !needsYear ||
    (Number.isInteger(yearNumber) && yearNumber >= 2000 && yearNumber <= 2100);

  const reset = () => {
    setSearch("");
    setDebounced("");
    setSelected(null);
    setYear(String(defaultYear));
  };

  const submit = async () => {
    if (!selected || !yearValid) return;
    try {
      await categorize.mutateAsync({
        documentPublicId: selected,
        recordCategory: category,
        recordYear: needsYear ? yearNumber : null,
      });
      toast.success("Document filed.");
      await utils.books.invalidate();
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The document could not be filed."));
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        File a document
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>File a document</DialogTitle>
            <DialogDescription>
              {def.label} (Section {def.section}). Upload new files on the{" "}
              <a href={documentsHref} className="underline">
                Documents page
              </a>{" "}
              first.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="books-search">Search documents</Label>
              <Input
                id="books-search"
                value={search}
                maxLength={100}
                placeholder="Document name"
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="max-h-64 overflow-y-auto rounded-md border">
              {list.isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Loading…</p>
              ) : list.error ? (
                <p className="p-3 text-sm text-red-700">
                  {errorText(list.error, "The documents could not be loaded.")}
                </p>
              ) : (list.data?.length ?? 0) === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No uncategorised documents
                  {debounced ? ` match "${debounced}"` : ""}.
                </p>
              ) : (
                <ul className="divide-y">
                  {list.data?.map((d) => (
                    <li key={d.publicId}>
                      <button
                        type="button"
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted ${
                          selected === d.publicId ? "bg-muted font-medium" : ""
                        }`}
                        aria-pressed={selected === d.publicId}
                        onClick={() => setSelected(d.publicId)}
                      >
                        <span className="break-all">{d.name}</span>
                        <span
                          className="shrink-0 text-xs text-muted-foreground"
                          suppressHydrationWarning
                        >
                          {new Date(d.createdAt).toLocaleDateString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {needsYear ? (
              <div className="space-y-1">
                <Label htmlFor="books-year">Fiscal year</Label>
                <Input
                  id="books-year"
                  type="number"
                  min={2000}
                  max={2100}
                  step={1}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  className="w-32"
                />
                {!yearValid ? (
                  <p className="text-xs text-red-700">
                    Enter a year between 2000 and 2100.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!selected || !yearValid || categorize.isPending}
              onClick={() => void submit()}
            >
              {categorize.isPending ? "Filing…" : "File document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
