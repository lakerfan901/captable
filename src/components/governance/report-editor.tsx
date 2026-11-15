"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateOnly } from "@/lib/date-only";
import { lastEndedQuarter } from "@/lib/governance/last-ended-quarter";
import {
  NOTICE_KINDS,
  type NoticeKind,
  type ReportFigures,
  TRANSFER_NOTICE_KINDS,
} from "@/lib/governance/report-figures";
import { api } from "@/trpc/react";
import type { MemberReportTypeValue } from "@/trpc/routers/member-report-router/schema";
import type { RouterOutputs } from "@/trpc/shared";
import { K1CoverageCard } from "./k1-coverage-card";
import { ReleaseDialog } from "./release-dialog";
import { ReportAttachments } from "./report-attachments";
import { ReportFiguresForm } from "./report-figures-form";
import { RichTextEditorLazy } from "./rich-text-editor-lazy";

// Member report draft editor, review-and-send dialog and the "New" menu of
// the reports page (03-governance.md G13). Every action is offered only with
// the matching `governance` permission; the server enforces it regardless.

type Get = RouterOutputs["memberReport"]["get"];

const TYPE_LABEL: Record<string, string> = {
  QUARTERLY: "Quarterly report",
  ANNUAL: "Annual financial statements",
  TAX_K1: "Schedule K-1 delivery",
  NOTICE: "Notice",
};

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** The period-end rule of `memberReport.release` (owner ruling). */
export function periodNotEndedText(periodEnd: string): string {
  return `This period has not ended yet. A report can be released, and the books closed, only after ${formatDateOnly(periodEnd)}.`;
}

/** QUARTERLY / ANNUAL whose period end is not strictly before today. */
export function periodNotEnded(
  type: string,
  periodEnd: string | null,
  today: string,
): boolean {
  return (
    (type === "QUARTERLY" || type === "ANNUAL") &&
    periodEnd !== null &&
    !(periodEnd < today)
  );
}

// ---------------------------------------------------------------------------
// New report menu

export function NewReportMenu({
  base,
  today,
}: {
  /** `/<companyPublicId>/reports` */
  base: string;
  /** Today in the company time zone. */
  today: string;
}) {
  const router = useRouter();
  const create = api.memberReport.create.useMutation();
  const [type, setType] = useState<MemberReportTypeValue | null>(null);
  const last = lastEndedQuarter(today);
  const [year, setYear] = useState(String(last.year));
  const [quarter, setQuarter] = useState(String(last.quarter));
  const [noticeKind, setNoticeKind] = useState<NoticeKind>("GENERAL");

  const openFor = (t: MemberReportTypeValue) => {
    setYear(
      String(t === "QUARTERLY" ? last.year : Number(today.slice(0, 4)) - 1),
    );
    setQuarter(String(last.quarter));
    setType(t);
  };

  const submit = async () => {
    if (!type) return;
    const fiscalYear = Number(year);
    if (
      type !== "NOTICE" &&
      !(
        Number.isInteger(fiscalYear) &&
        fiscalYear >= 2000 &&
        fiscalYear <= 2100
      )
    ) {
      toast.error("Enter a fiscal year between 2000 and 2100.");
      return;
    }
    try {
      const res = await create.mutateAsync(
        type === "NOTICE"
          ? { type, noticeKind }
          : type === "QUARTERLY"
            ? { type, fiscalYear, fiscalQuarter: Number(quarter) }
            : { type, fiscalYear },
      );
      setType(null);
      router.push(`${base}/${res.publicId}`);
    } catch (e) {
      toast.error(errorText(e, "The report could not be created."));
    }
  };

  // Transfer-notice copies are created from the transfer (G16), not here.
  const noticeKinds = (Object.keys(NOTICE_KINDS) as NoticeKind[]).filter(
    (k) => !TRANSFER_NOTICE_KINDS.includes(k),
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>New</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openFor("QUARTERLY")}>
            Quarterly report
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openFor("ANNUAL")}>
            Annual financial statements
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openFor("TAX_K1")}>
            Schedule K-1 delivery
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openFor("NOTICE")}>
            Notice
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={type !== null}
        onOpenChange={(o) => (o ? null : setType(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{type ? TYPE_LABEL[type] : ""}</DialogTitle>
            <DialogDescription>
              {type === "QUARTERLY"
                ? "The figures are prefilled from the ledger for the quarter."
                : type === "ANNUAL"
                  ? "Attach the balance sheet and the income statement next."
                  : type === "TAX_K1"
                    ? "Attach each holder's Schedule K-1 next."
                    : "Write the notice next."}
            </DialogDescription>
          </DialogHeader>
          {type === "NOTICE" ? (
            <div className="space-y-1">
              <Label>Kind of notice</Label>
              <Select
                value={noticeKind}
                onValueChange={(v) => setNoticeKind(v as NoticeKind)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {noticeKinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {NOTICE_KINDS[k].label} (Section {NOTICE_KINDS[k].section}
                      )
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex gap-3">
              <div className="space-y-1">
                <Label htmlFor="report-fy">Fiscal year</Label>
                <Input
                  id="report-fy"
                  inputMode="numeric"
                  className="w-28"
                  value={year}
                  maxLength={4}
                  onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              {type === "QUARTERLY" ? (
                <div className="space-y-1">
                  <Label>Quarter</Label>
                  <Select value={quarter} onValueChange={setQuarter}>
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["1", "2", "3", "4"].map((q) => (
                        <SelectItem key={q} value={q}>
                          Q{q}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setType(null)}>
              Cancel
            </Button>
            <Button disabled={create.isPending} onClick={() => void submit()}>
              {create.isPending ? "Creating…" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Draft editor

export function ReportEditor({
  data,
  base,
  companyPublicId,
  today,
  canUpdate,
  canDelete,
  timeZone,
  mayInvite,
  showPortal,
}: {
  data: Get;
  base: string;
  companyPublicId: string;
  today: string;
  canUpdate: boolean;
  canDelete: boolean;
  timeZone: string;
  /** `portal: create`: the release dialog's invitation line. */
  mayInvite: boolean;
  /** `portal: read`: the Portal column of the audience picker. */
  showPortal: boolean;
}) {
  const router = useRouter();
  const { report } = data;
  const withFigures = report.type === "QUARTERLY" || report.type === "ANNUAL";
  const [title, setTitle] = useState(report.title);
  // null: the stored figures do not parse (e.g. more than 500 lines); saving
  // then shows the server's error as it is.
  const [figures, setFigures] = useState<ReportFigures | null>(report.figures);
  const [sendOpen, setSendOpen] = useState(false);
  const initialBlocks = Array.isArray(report.commentary)
    ? (report.commentary as unknown[])
    : [];
  // The editor reports on every change; keep the latest blocks in a ref so
  // typing does not re-render the whole page.
  const commentaryRef = useRef<unknown[]>(initialBlocks);
  const onCommentary = useCallback((blocks: unknown[]) => {
    commentaryRef.current = blocks;
  }, []);

  const update = api.memberReport.update.useMutation();
  const refresh = api.memberReport.refreshFigures.useMutation();
  const remove = api.memberReport.delete.useMutation();

  const save = async (): Promise<boolean> => {
    if (title.trim() === "") {
      toast.error("Give the report a title.");
      return false;
    }
    try {
      await update.mutateAsync({
        publicId: report.publicId,
        title: title.trim(),
        figures: withFigures ? figures : {},
        commentary: commentaryRef.current,
      });
      return true;
    } catch (e) {
      toast.error(errorText(e, "The draft could not be saved."));
      return false;
    }
  };

  const onSave = async () => {
    if (await save()) {
      toast.success("Draft saved.");
      router.refresh();
    }
  };

  const onRefresh = async () => {
    // Save first: the refresh keeps the stored notes and utilization.
    if (figures !== null && !(await save())) return;
    try {
      const res = await refresh.mutateAsync({ publicId: report.publicId });
      setFigures(res.figures);
      toast.success("Figures refreshed from the ledger.");
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The figures could not be refreshed."));
    }
  };

  const onReview = async () => {
    if (await save()) {
      router.refresh();
      setSendOpen(true);
    }
  };

  const onDelete = async () => {
    try {
      await remove.mutateAsync({ publicId: report.publicId });
      toast.success("Draft deleted.");
      router.push(base);
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The draft could not be deleted."));
    }
  };

  const busy = update.isPending || remove.isPending || refresh.isPending;
  const notEnded =
    periodNotEnded(report.type, report.periodEnd, today) && report.periodEnd
      ? periodNotEndedText(report.periodEnd)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Link href={base} className="text-sm text-muted-foreground">
        ← Reports
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Title"
          className="max-w-2xl flex-1 font-medium"
          value={title}
          maxLength={200}
          disabled={!canUpdate}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Badge variant="warning">Draft</Badge>
        <span className="text-sm text-muted-foreground">
          {TYPE_LABEL[report.type] ?? report.type}
          {report.periodStart && report.periodEnd
            ? ` · ${formatDateOnly(report.periodStart)} – ${formatDateOnly(report.periodEnd)}`
            : ""}
          {report.dueOn ? ` · due ${formatDateOnly(report.dueOn)}` : ""}
        </span>
      </div>
      {notEnded ? <p className="text-sm text-amber-700">{notEnded}</p> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          {withFigures ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Figures (Section 8.2)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {figures === null ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-red-600">
                      The stored figures of this draft cannot be read (for
                      example, the period has more payment lines than a report
                      can hold). Saving shows the reason.
                    </p>
                    {canUpdate ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void onRefresh()}
                      >
                        Refresh from ledger
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <ReportFiguresForm
                    // Remount on refresh: the read-only/removable line
                    // split is taken at mount.
                    key={figures.source?.fetchedAt ?? "none"}
                    timeZone={timeZone}
                    type={report.type as "QUARTERLY" | "ANNUAL"}
                    figures={figures}
                    onChange={setFigures}
                    disabled={!canUpdate || busy}
                    onRefresh={() => void onRefresh()}
                    refreshing={refresh.isPending}
                  />
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {report.type === "NOTICE" ? "Notice text" : "Commentary"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RichTextEditorLazy
                initialBlocks={initialBlocks}
                onChange={onCommentary}
                editable={canUpdate}
              />
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Checklist</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">As last saved.</p>
              <ul className="space-y-1">
                {data.checklist.map((i) => (
                  <li key={i.key} className="flex gap-2">
                    <span
                      className={i.ok ? "text-green-600" : "text-red-600"}
                      aria-hidden
                    >
                      {i.ok ? "✓" : "✗"}
                    </span>
                    <span>
                      {i.label}{" "}
                      <span className="text-muted-foreground">
                        (Section {i.section})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {data.k1Coverage ? (
            <K1CoverageCard coverage={data.k1Coverage} status={report.status} />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {report.type === "TAX_K1" ? "Schedules K-1" : "Attachments"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ReportAttachments
                publicId={report.publicId}
                companyPublicId={companyPublicId}
                type={report.type}
                status={report.status}
                attachments={data.attachments}
                candidates={data.candidates}
                canUpdate={canUpdate}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {canUpdate || canDelete ? (
        <div className="flex flex-wrap gap-2">
          {canUpdate ? (
            <Button
              variant="outline"
              onClick={() => void onSave()}
              loading={update.isPending}
              disabled={busy}
            >
              Save
            </Button>
          ) : null}
          {canDelete ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={busy}>
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Nothing has been sent. The draft is removed and cannot be
                    recovered.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void onDelete()}>
                    Delete draft
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
          {canUpdate ? (
            <Button onClick={() => void onReview()} disabled={busy}>
              Release…
            </Button>
          ) : null}
        </div>
      ) : null}

      {sendOpen ? (
        <ReleaseDialog
          publicId={report.publicId}
          today={today}
          mayInvite={mayInvite}
          showPortal={showPortal}
          onClose={() => setSendOpen(false)}
          onReleased={() => {
            setSendOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
