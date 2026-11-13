"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAllowed } from "@/hooks/use-allowed";
import { formatDateOnly, isValidDateOnly } from "@/lib/date-only";
import {
  CUSTOM_DEADLINE_TEMPLATE_KEYS,
  CUSTOM_DEADLINE_TEMPLATES,
  type CustomDeadlineTemplate,
  type CustomDeadlineTemplateKey,
} from "@/lib/governance/compliance-core";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

// Dialogs of the compliance calendar (03-governance.md G15): add a deadline,
// mark one done, mark one not applicable, edit one. Each closes on success,
// toasts, and refreshes the server page; a server refusal is shown as a toast
// with the server's message.

export type ComplianceRow = RouterOutputs["compliance"]["list"][number];

export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Calendar-day arithmetic on `YYYY-MM-DD` (UTC, no rolling). */
function addCalendarDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Add deadline

const CUSTOM = "CUSTOM";
type TemplateChoice = CustomDeadlineTemplateKey | typeof CUSTOM;

function templateOf(choice: TemplateChoice): CustomDeadlineTemplate | null {
  return choice === CUSTOM ? null : CUSTOM_DEADLINE_TEMPLATES[choice];
}

function offsetText(offset: { days?: number; businessDays?: number }): string {
  if (offset.businessDays) {
    return `${offset.businessDays} business days after the trigger date`;
  }
  return `${offset.days ?? 0} days after the trigger date`;
}

export function AddDeadlineDialog() {
  const router = useRouter();
  const create = api.compliance.createCustom.useMutation();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<TemplateChoice>(CUSTOM);
  const [title, setTitle] = useState("");
  const [section, setSection] = useState("");
  const [dateValue, setDateValue] = useState("");
  const [description, setDescription] = useState("");

  const template = templateOf(choice);
  const usesTrigger = template !== null && template.offset !== null;
  const dateValid = isValidDateOnly(dateValue);
  const canSubmit = title.trim() !== "" && dateValid && !create.isPending;

  // Calendar-day offsets are plain arithmetic and exact; business-day offsets
  // depend on the company's holiday settings, so only the server's answer
  // (shown after saving) is the date.
  let preview: string | null = null;
  if (usesTrigger && template.offset !== null) {
    if (template.offset.businessDays) {
      preview = `Due ${offsetText(template.offset)}, using the company's holiday calendar. The exact date is shown once the deadline is added.`;
    } else if (dateValid) {
      preview = `Due ${formatDateOnly(addCalendarDays(dateValue, template.offset.days ?? 0))} (${offsetText(template.offset)}).`;
    } else {
      preview = `Due ${offsetText(template.offset)}.`;
    }
  }

  const reset = () => {
    setChoice(CUSTOM);
    setTitle("");
    setSection("");
    setDateValue("");
    setDescription("");
  };

  const choose = (next: TemplateChoice) => {
    setChoice(next);
    setDateValue("");
    const t = templateOf(next);
    setTitle(t ? t.title : "");
    setSection("");
  };

  const submit = async () => {
    if (!canSubmit) return;
    const base = {
      title: title.trim(),
      ...(description.trim() !== "" ? { description: description.trim() } : {}),
    };
    try {
      const res = await create.mutateAsync(
        choice === CUSTOM
          ? {
              ...base,
              dueOn: dateValue,
              ...(section.trim() !== "" ? { section: section.trim() } : {}),
            }
          : usesTrigger
            ? { ...base, templateKey: choice, triggerOn: dateValue }
            : { ...base, templateKey: choice, dueOn: dateValue },
      );
      toast.success(`Deadline added, due ${formatDateOnly(res.dueOn)}.`);
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The deadline could not be added."));
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>Add deadline</Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add deadline</DialogTitle>
            <DialogDescription>
              Choose a deadline under the Operating Agreement or a statutory
              filing, or enter your own.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="compliance-template">Deadline</Label>
              <Select
                value={choice}
                onValueChange={(v) => choose(v as TemplateChoice)}
              >
                <SelectTrigger id="compliance-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_DEADLINE_TEMPLATE_KEYS.map((key) => {
                    const t = CUSTOM_DEADLINE_TEMPLATES[key];
                    return (
                      <SelectItem key={key} value={key}>
                        {t.title}
                        {t.section ? ` (Section ${t.section})` : ""}
                      </SelectItem>
                    );
                  })}
                  <SelectItem value={CUSTOM}>Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="compliance-date">
                {usesTrigger ? triggerLabel(choice) : "Due date"}
              </Label>
              <Input
                id="compliance-date"
                type="date"
                value={dateValue}
                onChange={(e) => setDateValue(e.target.value)}
                className="w-48"
              />
              {preview ? (
                <p className="text-xs text-muted-foreground">{preview}</p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="compliance-title">Title</Label>
              <Input
                id="compliance-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {choice === CUSTOM ? (
              <div className="space-y-1">
                <Label htmlFor="compliance-section">
                  Section of the Operating Agreement (optional)
                </Label>
                <Input
                  id="compliance-section"
                  value={section}
                  maxLength={50}
                  placeholder="8.2"
                  onChange={(e) => setSection(e.target.value)}
                  className="w-48"
                />
              </div>
            ) : null}

            <div className="space-y-1">
              <Label htmlFor="compliance-description">
                Description (optional)
              </Label>
              <Textarea
                id="compliance-description"
                value={description}
                maxLength={2000}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
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
            <Button disabled={!canSubmit} onClick={() => void submit()}>
              {create.isPending ? "Adding…" : "Add deadline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const TRIGGER_LABEL: Partial<Record<CustomDeadlineTemplateKey, string>> = {
  TAX_PROCEEDING_NOTICE: "Date the notice of the proceeding was received",
  SPECIAL_MEETING_NOTICE: "Date of the valid request",
  SPECIAL_MEETING_HELD: "Date of the request",
  MANAGER_RESIGNATION_EFFECTIVE: "Date of the resignation notice",
  SUCCESSOR_ACCEPTANCE: "Date of the resignation notice",
  PO_TITLE_DOCUMENTS: "Date of the vendor payment",
  PO_FUNDS_REMIT: "Date the funds were received",
  SUBSCRIPTION_ACCEPTANCE:
    "Date the signature page and Initial Installment were received",
};

function triggerLabel(choice: TemplateChoice): string {
  return choice === CUSTOM
    ? "Due date"
    : (TRIGGER_LABEL[choice] ?? "Trigger date");
}

// ---------------------------------------------------------------------------
// Mark done

type DoneKind = "MEMBER_REPORT" | "RESOLUTION" | "DOCUMENT" | "MANUAL";

const NON_DRAFT_RESOLUTION = [
  "SENT",
  "EFFECTIVE",
  "FAILED",
  "EXPIRED",
  "WITHDRAWN",
] as const;

export function MarkDoneDialog({
  row,
  open,
  onOpenChange,
}: {
  row: ComplianceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const complete = api.compliance.complete.useMutation();
  const { isAllowed: canReadDocuments } = useAllowed({
    subject: "documents",
    action: "read",
  });
  const [kind, setKind] = useState<DoneKind>("MEMBER_REPORT");
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");

  const reports = api.memberReport.list.useQuery(
    {},
    { enabled: open && kind === "MEMBER_REPORT" },
  );
  const resolutions = api.resolution.options.useQuery(
    { statuses: [...NON_DRAFT_RESOLUTION] },
    { enabled: open && kind === "RESOLUTION" },
  );
  const documents = api.document.getAll.useQuery(undefined, {
    enabled: open && kind === "DOCUMENT" && canReadDocuments,
  });

  const sentReports = (reports.data ?? [])
    .filter((r) => r.status === "SENT")
    .sort((a, b) => {
      const at = a.sentAt ? new Date(a.sentAt).getTime() : 0;
      const bt = b.sentAt ? new Date(b.sentAt).getTime() : 0;
      return bt - at;
    })
    .map((r) => ({ value: r.publicId, label: r.title }));
  const resolutionOptions = (resolutions.data ?? []).map((r) => ({
    value: r.publicId,
    label: r.referenceCode ? `${r.referenceCode} ${r.title}` : r.title,
  }));
  const documentOptions = (documents.data ?? []).map((d) => ({
    value: d.publicId,
    label: d.name,
  }));

  const reset = () => {
    setKind("MEMBER_REPORT");
    setSelected("");
    setNote("");
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };

  const canSubmit =
    !complete.isPending &&
    (kind === "MANUAL" ? note.trim() !== "" : selected !== "");

  const submit = async () => {
    if (!canSubmit) return;
    try {
      await complete.mutateAsync({
        id: row.id,
        satisfiedByType: kind,
        ...(kind === "MANUAL" ? {} : { satisfiedByPublicId: selected }),
        ...(note.trim() !== "" ? { note: note.trim() } : {}),
      });
      toast.success("Deadline marked done.");
      close();
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The deadline could not be marked done."));
    }
  };

  const picker = (
    query: { isLoading: boolean; error: unknown },
    options: { value: string; label: string }[],
    empty: string,
    placeholder: string,
  ) => {
    if (query.isLoading) {
      return <p className="text-sm text-muted-foreground">Loading…</p>;
    }
    if (query.error) {
      return (
        <p className="text-sm text-red-700">
          {errorText(query.error, "The list could not be loaded.")}
        </p>
      );
    }
    if (options.length === 0) {
      return <p className="text-sm text-muted-foreground">{empty}</p>;
    }
    return (
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger aria-label={placeholder}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark done</DialogTitle>
          <DialogDescription>
            {row.title}, due {formatDateOnly(row.dueOn)}. Choose what satisfied
            it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioGroup
            value={kind}
            onValueChange={(v) => {
              setKind(v as DoneKind);
              setSelected("");
            }}
          >
            {(
              [
                ["MEMBER_REPORT", "A report"],
                ["RESOLUTION", "A resolution"],
                ["DOCUMENT", "A document"],
                ["MANUAL", "Other"],
              ] as const
            ).map(([value, label]) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem value={value} id={`done-${value}`} />
                <Label htmlFor={`done-${value}`}>{label}</Label>
              </div>
            ))}
          </RadioGroup>

          {kind === "MEMBER_REPORT"
            ? picker(
                reports,
                sentReports,
                "No report has been sent yet.",
                "Choose a sent report",
              )
            : null}
          {kind === "RESOLUTION"
            ? picker(
                resolutions,
                resolutionOptions,
                "No resolution has been sent yet.",
                "Choose a resolution",
              )
            : null}
          {kind === "DOCUMENT" ? (
            canReadDocuments ? (
              picker(
                documents,
                documentOptions,
                "No documents have been uploaded.",
                "Choose a document",
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                You do not have access to the company's documents.
              </p>
            )
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="done-note">
              {kind === "MANUAL" ? "How was it done?" : "Note (optional)"}
            </Label>
            <Textarea
              id="done-note"
              value={note}
              maxLength={1000}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {complete.isPending ? "Saving…" : "Mark done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Not applicable

export function NotApplicableDialog({
  row,
  open,
  onOpenChange,
}: {
  row: ComplianceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const mark = api.compliance.markNotApplicable.useMutation();
  const [note, setNote] = useState("");

  const close = () => {
    onOpenChange(false);
    setNote("");
  };
  const canSubmit = note.trim() !== "" && !mark.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    try {
      await mark.mutateAsync({ id: row.id, note: note.trim() });
      toast.success("Deadline marked not applicable.");
      close();
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The deadline could not be changed."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Not applicable</DialogTitle>
          <DialogDescription>
            {row.title}, due {formatDateOnly(row.dueOn)}. Say why it does not
            apply.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="na-note">Reason</Label>
          <Textarea
            id="na-note"
            value={note}
            maxLength={1000}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {mark.isPending ? "Saving…" : "Mark not applicable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit

export function EditDeadlineDialog({
  row,
  open,
  onOpenChange,
}: {
  row: ComplianceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const update = api.compliance.update.useMutation();
  const [title, setTitle] = useState(row.title);
  const [dueOn, setDueOn] = useState(row.dueOn);
  const [description, setDescription] = useState(row.description ?? "");

  const reset = () => {
    setTitle(row.title);
    setDueOn(row.dueOn);
    setDescription(row.description ?? "");
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };

  const canSubmit =
    !update.isPending &&
    (!row.canEditTitle || title.trim() !== "") &&
    (!row.canEditDueOn || isValidDateOnly(dueOn));

  const submit = async () => {
    if (!canSubmit) return;
    try {
      // The server refuses a title on a non-custom deadline and a date on a
      // deadline whose date is fixed, so only editable fields are sent.
      await update.mutateAsync({
        id: row.id,
        ...(row.canEditTitle && title.trim() !== row.title
          ? { title: title.trim() }
          : {}),
        ...(row.canEditDueOn && dueOn !== row.dueOn ? { dueOn } : {}),
        ...(description.trim() !== (row.description ?? "")
          ? { description: description.trim() }
          : {}),
      });
      toast.success("Deadline updated.");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The deadline could not be updated."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          reset();
          onOpenChange(true);
        } else {
          close();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit deadline</DialogTitle>
          <DialogDescription>
            {row.canEditTitle
              ? "Change the title, the due date or the description."
              : `${row.title}. Change the due date (for example, after an extension) or the description.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {row.canEditTitle ? (
            <div className="space-y-1">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                id="edit-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          ) : null}
          {row.canEditDueOn ? (
            <div className="space-y-1">
              <Label htmlFor="edit-due">Due date</Label>
              <Input
                id="edit-due"
                type="date"
                value={dueOn}
                onChange={(e) => setDueOn(e.target.value)}
                className="w-48"
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={description}
              maxLength={2000}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
