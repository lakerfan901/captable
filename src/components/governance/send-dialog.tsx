"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { addDays, todayInZone } from "@/lib/governance/dates";
import {
  behaviour,
  buildRequirements,
  type ResolutionType,
} from "@/lib/governance/presets";
import { api } from "@/trpc/react";

// Send dialog (03-governance.md G10, session b). Sending is irreversible: it
// freezes the text and the register, records the signatures and emails the
// binding ballot links.

export const EXCLUSION_REASON_TEXT: Record<string, string> = {
  SUSPENDED: "Units suspended for default (Section 4.9(iii))",
  FINANCIAL_INTEREST_ONLY:
    "Holds a Financial Interest only (Sections 1.23, 7.9.2)",
  INSIDER: "Not a Disinterested holder (Section 1.18)",
  NO_PREFERRED_UNITS: "Holds no Preferred Units",
};

export const DEFAULT_CAPACITY = "Authorized signatory of the Manager";

/** Word the Manager types to confirm. */
export function confirmWord(type: ResolutionType): string {
  return type === "PURCHASE_ORDER" ? "SIGN" : "SEND";
}

/** Requirement kinds of the params, or [] when they do not validate. */
function requirementKinds(type: ResolutionType, params: unknown): string[] {
  try {
    return buildRequirements(type, params).map((s) => s.requirement.kind);
  } catch {
    return [];
  }
}

function validSignature(name: string, capacity: string): boolean {
  const n = name.trim().length;
  const c = capacity.trim().length;
  return n >= 2 && n <= 200 && c >= 2 && c <= 200;
}

export interface SendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publicId: string;
  type: ResolutionType;
  params: Record<string, unknown>;
  mailCatcher: boolean;
  defaultSignerName: string;
  /** The company's time zone: `send` measures the record date and deadline in it. */
  timeZone: string;
}

export function SendDialog({
  open,
  onOpenChange,
  publicId,
  type,
  params,
  mailCatcher,
  defaultSignerName,
  timeZone,
}: SendDialogProps) {
  const router = useRouter();
  const b = behaviour(type);
  const isPo = type === "PURCHASE_ORDER";
  const isTermExtension = b.fixedWindowDays !== null;
  // The server measures dates in the company's time zone; use the same.
  const today = useMemo(() => todayInZone(new Date(), timeZone), [timeZone]);

  const [recordDate, setRecordDate] = useState(today);
  const [closesOn, setClosesOn] = useState(addDays(today, 30));
  const [autoReminders, setAutoReminders] = useState(true);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [signerName, setSignerName] = useState(defaultSignerName);
  const [signerCapacity, setSignerCapacity] = useState(DEFAULT_CAPACITY);
  const [alsoCommon, setAlsoCommon] = useState(false);
  const [commonName, setCommonName] = useState(defaultSignerName);
  const [commonCapacity, setCommonCapacity] = useState(
    "Authorized signatory of the Common Member",
  );
  const [typed, setTyped] = useState("");

  const kinds = requirementKinds(type, params);
  const needsManager = kinds.includes("MANAGER_APPROVAL");
  const offerCommon =
    type === "AMENDMENT" && params.adverseToCommon === true && needsManager;

  const recordDateValid = /^\d{4}-\d{2}-\d{2}$/.test(recordDate);
  const preview = api.resolution.preview.useQuery(
    { type, params, recordDate },
    { enabled: open && recordDateValid && recordDate <= today, retry: false },
  );
  const send = api.resolution.send.useMutation();

  const recipients = preview.data?.recipients ?? [];
  const selected = recipients.filter((r) => !unchecked.has(r.stakeholderId));
  const minClose = addDays(today, 1);
  const maxClose = addDays(today, 180);
  const closeValid =
    !b.hasBallots ||
    isTermExtension ||
    (closesOn >= minClose && closesOn <= maxClose);

  const word = confirmWord(type);
  const problems: string[] = [];
  if (!recordDateValid || recordDate > today)
    problems.push("The record date cannot be in the future.");
  if (!closeValid)
    problems.push(
      `The response deadline must be between ${minClose} and ${maxClose}.`,
    );
  if (b.hasBallots && preview.data && selected.length === 0)
    problems.push("Choose at least one Member to ask.");
  // Conditions `send` refuses (M5: overdue Balance with no declared default).
  for (const blocker of preview.data?.blockers ?? []) problems.push(blocker);
  if (needsManager && !validSignature(signerName, signerCapacity))
    problems.push("Enter the signer's name and capacity (2–200 characters).");
  if (alsoCommon && !validSignature(commonName, commonCapacity))
    problems.push(
      "Enter the Common Member signer's name and capacity (2–200 characters).",
    );

  const canSend =
    preview.isSuccess &&
    problems.length === 0 &&
    typed.trim().toUpperCase() === word &&
    !send.isPending;

  const onSend = async () => {
    try {
      const allSelected = selected.length === recipients.length;
      const r = await send.mutateAsync({
        publicId,
        recordDate,
        closesOn: b.hasBallots && !isTermExtension ? closesOn : undefined,
        recipientStakeholderIds:
          b.hasBallots && !allSelected
            ? selected.map((s) => s.stakeholderId)
            : undefined,
        autoReminders: b.hasBallots ? autoReminders : false,
        managerSignature: needsManager
          ? {
              signerName: signerName.trim(),
              signerCapacity: signerCapacity.trim(),
            }
          : undefined,
        commonMemberSignature: alsoCommon
          ? {
              signerName: commonName.trim(),
              signerCapacity: commonCapacity.trim(),
            }
          : undefined,
      });
      toast.success(
        isPo
          ? `Resolution ${r.referenceCode} signed and delivered to Members.`
          : `Resolution ${r.referenceCode} sent to ${selected.length} Member${selected.length === 1 ? "" : "s"}.`,
      );
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = (id: string, checked: boolean) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const buttonLabel = isPo
    ? "Sign and deliver to Members"
    : `Send to ${selected.length} Member${selected.length === 1 ? "" : "s"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isPo ? "Sign and deliver resolution" : "Review and send"}
          </DialogTitle>
          <DialogDescription>
            {isPo
              ? "Signing is final. The resolution is signed electronically on behalf of the Manager, becomes effective immediately and a copy is emailed to all Members. The text can no longer be edited or withdrawn."
              : "Sending is final. The text and the register of Members on the record date are frozen, your signature is recorded, and each Member below is emailed a ballot link. Votes cast through those links are binding written consents. The text can no longer be edited."}
          </DialogDescription>
        </DialogHeader>

        {mailCatcher ? (
          <Alert variant="destructive">
            <AlertTitle>Test mode</AlertTitle>
            <AlertDescription>
              Test mode: emails go to the mail catcher and are not delivered.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 text-sm">
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="rs-record-date">Record date</Label>
            <Input
              id="rs-record-date"
              type="date"
              value={recordDate}
              max={today}
              onChange={(e) => {
                setRecordDate(e.target.value);
                setUnchecked(new Set());
              }}
            />
          </div>

          {preview.isLoading && preview.fetchStatus !== "idle" ? (
            <div className="grid gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-6 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : preview.isError ? (
            <p className="text-destructive">{preview.error.message}</p>
          ) : preview.data ? (
            <>
              <section className="grid gap-2">
                <h4 className="font-medium">Approval required</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Requirement</TableHead>
                      <TableHead>Section</TableHead>
                      <TableHead className="text-right">
                        Outstanding units entitled to vote
                      </TableHead>
                      <TableHead className="text-right">Minimum For</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.data.requirements.map((r) => (
                      <TableRow key={`${r.label}-${r.section}`}>
                        <TableCell>{r.label}</TableCell>
                        <TableCell>{r.section}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.denominator ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.minimumFor ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>

              {b.hasBallots ? (
                <section className="grid gap-2">
                  <h4 className="font-medium">Members asked</h4>
                  {b.allRecipientsRequired ? (
                    <p className="text-muted-foreground">
                      Section 2.5: every Preferred Member is asked
                    </p>
                  ) : null}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8" />
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead className="text-right">
                          Preferred Units
                        </TableHead>
                        <TableHead>Counts for</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recipients.map((r) => (
                        <TableRow key={r.stakeholderId}>
                          <TableCell>
                            <Checkbox
                              aria-label={`Ask ${r.name}`}
                              checked={!unchecked.has(r.stakeholderId)}
                              disabled={b.allRecipientsRequired}
                              onCheckedChange={(c) =>
                                toggle(r.stakeholderId, c === true)
                              }
                            />
                          </TableCell>
                          <TableCell>{r.name}</TableCell>
                          <TableCell>{r.email ?? "no email"}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {r.preferredUnits}
                          </TableCell>
                          <TableCell className="flex flex-wrap gap-1">
                            {r.countsPreferred ? (
                              <Badge variant="secondary">
                                Counts for Preferred vote
                              </Badge>
                            ) : null}
                            {r.countsDisinterested ? (
                              <Badge variant="secondary">
                                Counts for Disinterested vote
                              </Badge>
                            ) : null}
                            {r.consentOnly ? (
                              <Badge variant="outline">Consent only</Badge>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {unchecked.size > 0 ? (
                    <p className="text-muted-foreground">
                      Units of Members you do not ask still count in the
                      denominator.
                    </p>
                  ) : null}
                </section>
              ) : null}

              {preview.data.excluded.length > 0 ? (
                <section className="grid gap-2">
                  <h4 className="font-medium">Not entitled to vote</h4>
                  <ul className="grid gap-1">
                    {preview.data.excluded.map((x) => (
                      <li key={x.stakeholderId}>
                        <span className="font-medium">{x.name}</span>{" "}
                        <span className="text-muted-foreground">
                          {EXCLUSION_REASON_TEXT[x.reason] ?? x.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {preview.data.warnings.length > 0 ? (
                <Alert variant="destructive">
                  <AlertTitle>Check before sending</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {preview.data.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}

          {b.hasBallots ? (
            isTermExtension ? (
              <p>
                Responses close 30 days after sending (Section 2.5);
                non-responders are deemed to vote against.
              </p>
            ) : (
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="rs-closes-on">Respond by</Label>
                <Input
                  id="rs-closes-on"
                  type="date"
                  value={closesOn}
                  min={minClose}
                  max={maxClose}
                  onChange={(e) => setClosesOn(e.target.value)}
                />
              </div>
            )
          ) : null}

          {b.hasBallots ? (
            <div className="flex items-center gap-2">
              <Switch
                id="rs-reminders"
                checked={autoReminders}
                onCheckedChange={setAutoReminders}
              />
              <Label htmlFor="rs-reminders">
                Send automatic reminders 7 and 2 days before the deadline
              </Label>
            </div>
          ) : null}

          {needsManager ? (
            <section className="grid gap-2 rounded border p-3">
              <h4 className="font-medium">Manager signature</h4>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="rs-signer">Signer name</Label>
                  <Input
                    id="rs-signer"
                    value={signerName}
                    maxLength={200}
                    onChange={(e) => setSignerName(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="rs-capacity">Title / capacity</Label>
                  <Input
                    id="rs-capacity"
                    value={signerCapacity}
                    maxLength={200}
                    onChange={(e) => setSignerCapacity(e.target.value)}
                  />
                </div>
              </div>
              <p>
                By sending, I sign this resolution electronically on behalf of
                the Manager (Sections 6.12 and 13.9).
              </p>
              {offerCommon ? (
                <div className="grid gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="rs-also-common"
                      checked={alsoCommon}
                      onCheckedChange={(c) => setAlsoCommon(c === true)}
                    />
                    <Label htmlFor="rs-also-common">
                      Also sign for the Common Member
                    </Label>
                  </div>
                  {alsoCommon ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label htmlFor="rs-common-signer">Signer name</Label>
                        <Input
                          id="rs-common-signer"
                          value={commonName}
                          maxLength={200}
                          onChange={(e) => setCommonName(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="rs-common-capacity">
                          Title / capacity
                        </Label>
                        <Input
                          id="rs-common-capacity"
                          value={commonCapacity}
                          maxLength={200}
                          onChange={(e) => setCommonCapacity(e.target.value)}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {problems.length > 0 ? (
            <ul className="grid gap-1 text-destructive">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}

          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="rs-confirm">Type {word} to confirm</Label>
            <Input
              id="rs-confirm"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onSend}
            loading={send.isPending}
            disabled={!canSend}
          >
            {buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
