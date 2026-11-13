"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  type BooksCategory,
  completenessLabel,
  yearRequired,
} from "@/lib/governance/books-core";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { BooksFileDialog } from "./books-file-dialog";

// Books and records cards (03-governance.md G18): one card per Section 8.1
// category with its completeness chip, the filed documents and, for users
// who may update documents, "File a document" and "Remove from category"
// (manual documents only; documents the app filed stay where they are).

type Overview = RouterOutputs["books"]["overview"];
type CategoryRow = Overview["categories"][number];

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function chipVariant(
  row: CategoryRow,
): "success" | "destructive" | "info" | "secondary" {
  if (row.category === "MEMBER_LIST") return "info";
  if (row.complete === true) return "success";
  if (row.complete === false) return "destructive";
  return "secondary";
}

function defaultYearFor(row: CategoryRow, lastCompletedYear: number): number {
  const missing = row.years?.find((y) => !y.present);
  return missing?.year ?? lastCompletedYear;
}

function CategoryCard({
  row,
  companyPublicId,
  canUpdate,
  lastCompletedYear,
}: {
  row: CategoryRow;
  companyPublicId: string;
  canUpdate: boolean;
  lastCompletedYear: number;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const categorize = api.books.categorize.useMutation();
  const [removing, setRemoving] = useState<string | null>(null);
  const category = row.category as BooksCategory;
  const showYear =
    yearRequired(category) || row.documents.some((d) => d.recordYear !== null);

  const remove = async (documentPublicId: string) => {
    setRemoving(documentPublicId);
    try {
      await categorize.mutateAsync({
        documentPublicId,
        recordCategory: null,
        recordYear: null,
      });
      toast.success("Removed from the books and records.");
      await utils.books.invalidate();
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The document could not be removed."));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium">{row.label}</h3>
          <p className="text-xs text-muted-foreground">
            Section {row.section} of the Operating Agreement
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={chipVariant(row)}>
            {completenessLabel(
              category,
              { years: row.years, complete: row.complete },
              row.documents.length,
            )}
          </Badge>
          {canUpdate ? (
            <BooksFileDialog
              category={category}
              defaultYear={defaultYearFor(row, lastCompletedYear)}
              documentsHref={`/${companyPublicId}/documents`}
            />
          ) : null}
        </div>
      </div>

      {category === "MEMBER_LIST" ? (
        <p className="mt-3 text-sm">
          The current list is kept live on the{" "}
          <Link href={`/${companyPublicId}/stakeholders`} className="underline">
            Members page
          </Link>
          . {row.documents.length}{" "}
          {row.documents.length === 1 ? "dated copy" : "dated copies"} filed.
        </p>
      ) : null}

      {row.years && row.years.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {row.years.map((y) => (
            <Badge key={y.year} variant={y.present ? "success" : "destructive"}>
              {y.year}: {y.present ? "present" : "missing"}
            </Badge>
          ))}
        </div>
      ) : null}

      {row.documents.length === 0 ? (
        category === "MEMBER_LIST" ? null : (
          <p className="mt-3 text-sm text-muted-foreground">
            No documents filed.
          </p>
        )
      ) : (
        <ul className="mt-3 divide-y rounded-md border">
          {row.documents.map((d) => (
            <li
              key={d.publicId}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Link
                  href={`/${companyPublicId}/documents/${d.bucketId}`}
                  className="break-all hover:underline"
                >
                  {d.name}
                </Link>
                {showYear && d.recordYear !== null ? (
                  <span className="text-muted-foreground">{d.recordYear}</span>
                ) : null}
                {d.generated ? (
                  <Badge variant="secondary">Generated</Badge>
                ) : null}
              </div>
              {canUpdate && !d.generated ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={removing !== null}
                  onClick={() => void remove(d.publicId)}
                >
                  {removing === d.publicId
                    ? "Removing…"
                    : "Remove from category"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function BooksOverview({
  overview,
  companyPublicId,
  canUpdate,
  lastCompletedYear,
}: {
  overview: Overview;
  companyPublicId: string;
  canUpdate: boolean;
  /** The last completed fiscal year, the dialog's default year. */
  lastCompletedYear: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      {overview.categories.map((row) => (
        <CategoryCard
          key={row.category}
          row={row}
          companyPublicId={companyPublicId}
          canUpdate={canUpdate}
          lastCompletedYear={lastCompletedYear}
        />
      ))}
    </div>
  );
}
