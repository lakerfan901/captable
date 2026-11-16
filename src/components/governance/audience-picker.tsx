"use client";

import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  applyPreset,
  filterHolders,
  MEMBER_STATUS_NOTE,
  PORTAL_STATE_LABEL,
  unitsText,
} from "@/lib/governance/release-view";
import type { HolderPortalState } from "@/lib/portal/audience-core";

// The audience picker (04-investor-portal.md 6.2, P18, P28; package P4c):
// preset buttons, a search box and a table of holders with tick boxes, the
// count selected and the warnings. Used by the report release dialog and
// "Add recipients"; P9 uses it for "Share with investors".
//
// Controlled: the caller owns the selection (`selected`, `onChange`) and
// computes the warnings (for reports with `audienceProblems`, through
// `releaseReview` / `addReview` in release-view.ts). Report-agnostic: the
// optional columns are switched by `showPortal` (only for a role with
// `portal: read`; absent otherwise, never greyed) and `showK1`.

export interface AudiencePickerHolder {
  stakeholderId: string;
  name: string;
  memberStatus: string;
  /** Decimal strings ("0.000000" when none). */
  preferredUnits: string;
  commonUnits: string;
  /** "" when the holder has no notice address. */
  noticeEmail: string;
  portal?: HolderPortalState;
  hasK1?: boolean;
  /** A short note after the name, e.g. "transferor". */
  note?: string;
  /** Lines under the name, e.g. the people who can sign in for this holder (P9). */
  details?: readonly string[];
}

export interface AudiencePickerPreset {
  key: string;
  label: string;
  stakeholderIds: readonly string[];
}

export interface AudiencePickerProps {
  holders: readonly AudiencePickerHolder[];
  presets: readonly AudiencePickerPreset[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Shown under the count; they never block. */
  warnings?: readonly { message: string }[];
  /** The "Portal" column (needs `portal: read`). */
  showPortal?: boolean;
  /** The "K-1 attached" column (TAX_K1 reports). */
  showK1?: boolean;
  /** After "{n} of {m} selected.", e.g. "Prospects cannot receive a report and are not listed." */
  countNote?: string;
  disabled?: boolean;
  /** The "Notice email" column; on by default (the share dialog of P9 lists people instead). */
  showNoticeEmail?: boolean;
}

export function AudiencePicker({
  holders,
  presets,
  selected,
  onChange,
  warnings = [],
  showPortal = false,
  showK1 = false,
  countNote,
  disabled = false,
  showNoticeEmail = true,
}: AudiencePickerProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const shown = filterHolders(holders, query);
  const count = holders.filter((h) => selected.has(h.stakeholderId)).length;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <Button
            key={p.key}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(applyPreset(holders, p.stakeholderIds))}
          >
            {p.label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onChange(applyPreset(holders, null))}
        >
          Clear
        </Button>
      </div>
      <Input
        id={searchId}
        placeholder="Search holders"
        aria-label="Search holders"
        value={query}
        maxLength={200}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="max-h-80 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">Select</span>
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="whitespace-nowrap">
                Class and units
              </TableHead>
              {showNoticeEmail ? (
                <TableHead className="whitespace-nowrap">
                  Notice email
                </TableHead>
              ) : null}
              {showPortal ? <TableHead>Portal</TableHead> : null}
              {showK1 ? <TableHead>K-1 attached</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={
                    3 +
                    (showNoticeEmail ? 1 : 0) +
                    (showPortal ? 1 : 0) +
                    (showK1 ? 1 : 0)
                  }
                  className="text-center text-muted-foreground"
                >
                  No holder matches.
                </TableCell>
              </TableRow>
            ) : (
              shown.map((h) => {
                const on = selected.has(h.stakeholderId);
                const status = MEMBER_STATUS_NOTE[h.memberStatus];
                const note = [status, h.note].filter(Boolean).join(", ");
                return (
                  <TableRow
                    key={h.stakeholderId}
                    data-state={on ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${h.name}`}
                        checked={on}
                        disabled={disabled}
                        onCheckedChange={(c) =>
                          toggle(h.stakeholderId, c === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {h.name}
                      {note ? (
                        <span className="text-xs font-normal text-muted-foreground">
                          {" "}
                          ({note})
                        </span>
                      ) : null}
                      {h.details && h.details.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs font-normal text-muted-foreground">
                          {h.details.map((d) => (
                            <li key={d} className="break-all">
                              {d}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {unitsText(h)}
                    </TableCell>
                    {showNoticeEmail ? (
                      <TableCell className="whitespace-nowrap">
                        {h.noticeEmail || (
                          <span className="text-muted-foreground">
                            No notice email
                          </span>
                        )}
                      </TableCell>
                    ) : null}
                    {showPortal ? (
                      <TableCell className="whitespace-nowrap">
                        {h.portal ? PORTAL_STATE_LABEL[h.portal] : "—"}
                      </TableCell>
                    ) : null}
                    {showK1 ? (
                      <TableCell>{h.hasK1 ? "Yes" : "No"}</TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm" aria-live="polite">
        <span className="font-medium">{count}</span> of {holders.length}{" "}
        selected.{countNote ? ` ${countNote}` : ""}
      </p>
      {warnings.length > 0 ? (
        <Alert>
          <AlertDescription>
            <ul className="space-y-1">
              {warnings.map((w) => (
                <li key={w.message}>{w.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
