"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InstantTime } from "@/components/common/instant-time";
import {
  AudiencePicker,
  type AudiencePickerHolder,
} from "@/components/governance/audience-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { type MailDeliveryState, TEST_MODE_TEXT } from "@/lib/mail-delivery";
import {
  candidateHolders,
  initialTicks,
  isSingle,
  missingMembers,
  PERSON_STATE_LABEL,
  pendingRemovals,
  peopleByHolder,
  plural,
  type ShareDocView,
  saveDiff,
  saveMessage,
  shareNotices,
  showPresets,
} from "@/lib/portal/share-dialog-view";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

// "Share with investors" (04-investor-portal.md 6.2, P13, P14, P28;
// package P9a). Opened from one document's row (edit its list: add,
// remove) or for several ticked rows (add the same holders to each).
// The Manager user picks the audience: one tick box per holder with the
// people who can sign in listed under it; presets only tick boxes; the
// saved list is exactly what is ticked. The caller renders this only for
// an LLC and a role with `portal: create`; Remove needs `portal: delete`.

type Options = RouterOutputs["portalAdmin"]["shareOptions"];
type Overview = RouterOutputs["portalAdmin"]["overview"];

export function ShareWithInvestorsDialog({
  documentPublicIds,
  canRemove,
  mailDelivery,
  onClose,
  onSaved,
}: {
  documentPublicIds: string[];
  canRemove: boolean;
  mailDelivery: MailDeliveryState;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The form starts from the saved list, so it waits for a fresh read: a
  // cached answer from an earlier opening would start from an old list.
  const options = api.portalAdmin.shareOptions.useQuery(
    { documentPublicIds },
    { refetchOnWindowFocus: false, gcTime: 0 },
  );
  const people = api.portalAdmin.overview.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const ready =
    options.data !== undefined &&
    options.isFetchedAfterMount &&
    !options.isFetching &&
    people.data !== undefined;

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl">
        {ready && options.data && people.data ? (
          <ShareForm
            options={options.data}
            people={people.data}
            canRemove={canRemove}
            mailDelivery={mailDelivery}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Share with investors</DialogTitle>
              <DialogDescription>
                {plural(documentPublicIds.length, "document", "documents")}{" "}
                selected.
              </DialogDescription>
            </DialogHeader>
            {options.error || people.error ? (
              <p className="text-sm text-destructive" role="alert">
                {(options.error ?? people.error)?.message}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({
  options,
  people,
  canRemove,
  mailDelivery,
  onClose,
  onSaved,
}: {
  options: Options;
  people: Overview;
  canRemove: boolean;
  mailDelivery: MailDeliveryState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const docs: ShareDocView[] = options.documents;
  const single = isSingle(docs) ? docs[0] : undefined;
  const [ticks, setTicks] = useState<Set<string>>(() =>
    initialTicks(docs, canRemove),
  );
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const share = api.portalAdmin.shareDocuments.useMutation();
  const unshare = api.portalAdmin.unshareDocument.useMutation();

  const byHolder = useMemo(() => peopleByHolder(people), [people]);
  const candidates = candidateHolders(options.holders, docs, canRemove);
  const pickerHolders: AudiencePickerHolder[] = candidates.map((h) => ({
    stakeholderId: h.stakeholderId,
    name: h.name,
    memberStatus: h.memberStatus,
    preferredUnits: h.preferredUnits,
    commonUnits: h.commonUnits,
    noticeEmail: "",
    portal: h.portal,
    details: (byHolder.get(h.stakeholderId) ?? []).map(
      (p) => `${p.email} — ${PERSON_STATE_LABEL[p.state]}`,
    ),
  }));
  const candidateIds = new Set(candidates.map((h) => h.stakeholderId));
  const presets = showPresets(docs)
    ? options.presets.map((p) => ({
        ...p,
        stakeholderIds: p.stakeholderIds.filter((id) => candidateIds.has(id)),
      }))
    : [];
  const missing = missingMembers(candidates, docs, ticks, canRemove);
  const notices = shareNotices(docs);
  const diff = saveDiff(docs, ticks, canRemove);
  const removals = single ? pendingRemovals(single, ticks, canRemove) : 0;
  const nothingToDo = diff.add.length === 0 && diff.remove.length === 0;
  const blocked = mailDelivery.blockedReason;

  const save = async () => {
    setError(null);
    if (nothingToDo) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      let holdersAdded = 0;
      let notificationsQueued = 0;
      let added = 0;
      if (diff.add.length > 0 && diff.documentPublicIds.length > 0) {
        const r = await share.mutateAsync({
          documentPublicIds: diff.documentPublicIds,
          stakeholderIds: diff.add,
          notify,
        });
        added = r.added;
        notificationsQueued = r.notificationsQueued;
        holdersAdded = new Set(
          r.documents.flatMap((d) => d.addedStakeholderIds),
        ).size;
      }
      let removed = 0;
      if (single && diff.remove.length > 0) {
        const r = await unshare.mutateAsync({
          documentPublicId: single.documentPublicId,
          stakeholderIds: diff.remove,
        });
        removed = r.removed;
      }
      toast.success(
        saveMessage({
          added,
          holdersAdded,
          removed,
          notify: notify && diff.add.length > 0,
          notificationsQueued,
        }),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sharing could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const removeNow = (stakeholderId: string) => {
    const next = new Set(ticks);
    next.delete(stakeholderId);
    setTicks(next);
  };
  const shownNow = single
    ? single.sharedWith.filter((s) => !canRemove || ticks.has(s.stakeholderId))
    : [];
  const pickerDisabled = single?.shareability.kind === "NONE";
  const { publicId } = useParams<{ publicId: string }>();

  return (
    <>
      <DialogHeader>
        <DialogTitle>Share with investors</DialogTitle>
        <DialogDescription>
          {single
            ? single.name
            : `${plural(docs.length, "document", "documents")} selected. The holders ticked below are added to each document’s list.`}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {notices.map((n) => (
          <Alert
            key={n.text}
            className={
              n.tone === "warning"
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : undefined
            }
            data-testid={
              n.tone === "warning" ? "share-warning" : "share-notice"
            }
          >
            <AlertDescription>{n.text}</AlertDescription>
          </Alert>
        ))}

        {single ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Shared with now</h4>
              {single.sharedWith.length > 0 ? (
                <Link
                  href={`/${publicId}/investor-portal?tab=activity&document=${encodeURIComponent(single.documentPublicId)}`}
                  className="text-xs text-muted-foreground underline underline-offset-4 hover:text-primary"
                >
                  See who opened it
                </Link>
              ) : null}
            </div>
            {shownNow.length > 0 ? (
              <ul className="divide-y rounded-md border" id="share-current">
                {shownNow.map((s) => (
                  <li
                    key={s.stakeholderId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="font-medium">
                      {s.name ?? "A deleted holder"}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        since <InstantTime at={s.sharedAt} dateOnly />
                      </span>
                      {canRemove ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeNow(s.stakeholderId)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not shared with anyone.
              </p>
            )}
            {removals > 0 ? (
              <p className="text-xs text-muted-foreground" id="share-removed">
                {plural(removals, "holder", "holders")} will be removed when you
                save.
              </p>
            ) : null}
          </div>
        ) : null}

        {!pickerDisabled && diff.documentPublicIds.length > 0 ? (
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Holders</h4>
            <AudiencePicker
              holders={pickerHolders}
              presets={presets}
              selected={ticks}
              onChange={setTicks}
              showPortal
              showNoticeEmail={false}
              countNote="The list is saved as it is; a Member admitted later is not added."
              disabled={busy}
            />
            {missing.message ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                id="share-missing"
              >
                <span>{missing.message}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setTicks(new Set([...ticks, ...missing.stakeholderIds]))
                  }
                >
                  Add them
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {diff.documentPublicIds.length > 0 && !pickerDisabled ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="share-notify"
                checked={notify}
                disabled={blocked !== null || busy}
                onCheckedChange={(c) => setNotify(c === true)}
              />
              <Label htmlFor="share-notify">
                Email them that new documents are available
              </Label>
            </div>
            {blocked ? (
              <p className="pl-6 text-xs text-muted-foreground">{blocked}</p>
            ) : notify ? (
              <p className="pl-6 text-xs text-muted-foreground">
                One email per person who can sign in for a holder added here.
                {mailDelivery.testMode ? ` ${TEST_MODE_TEXT}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="text-sm font-medium text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </>
  );
}
