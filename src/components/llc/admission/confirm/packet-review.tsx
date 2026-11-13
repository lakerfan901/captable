"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PacketStageBadge } from "@/components/llc/admission/packet-stage-badge";
import { Allow } from "@/components/rbac/allow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateOnly } from "@/lib/date-only";
import { api } from "@/trpc/react";
import { AnswersPanel } from "./answers-panel";
import { CountersignSection } from "./countersign-section";
import { DecisionSection } from "./decision-section";
import { DetailsForm } from "./details-form";
import { ReceiptsSection } from "./receipts-section";
import {
  type ManagerOption,
  type PacketView,
  ReviewProvider,
  useReview,
} from "./review-context";

// The Manager confirmation screen (01-foundation.md F13): one Exhibit B
// packet from review to countersignature.

function CancelButton() {
  const { view, busy, onError, reload } = useReview();
  const [open, setOpen] = useState(false);
  const mutation = api.admission.cancel.useMutation({
    onSuccess: () => {
      toast.success("Subscription cancelled.");
      setOpen(false);
      reload();
    },
    onError,
  });
  const { stage } = view.packet;
  const cancellable =
    view.commitment === null &&
    (stage === "AWAITING_INVESTOR" || stage === "AWAITING_REVIEW");
  if (!cancellable) return null;
  return (
    <Allow subject="commitments" action="update">
      <Button variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        Cancel subscription
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel subscription</DialogTitle>
            <DialogDescription>
              The links sent to {view.stakeholder.name} stop working. This
              cannot be undone; send a new subscription if needed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({ publicId: view.packet.publicId })
              }
            >
              Cancel subscription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Allow>
  );
}

function Header() {
  const { view, companyPublicId } = useReview();
  const { packet, stakeholder } = view;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <Link
          href={`/${companyPublicId}/admissions`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Admissions
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{stakeholder.name}</h3>
          <PacketStageBadge stage={packet.stage} />
        </div>
        <p className="text-sm text-muted-foreground">
          {packet.sourceMasterName ?? packet.name} · sent{" "}
          {formatDateOnly(packet.createdAt.slice(0, 10))} ·{" "}
          <Link
            href={`/${companyPublicId}/stakeholders/${stakeholder.id}`}
            className="underline"
          >
            member page
          </Link>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <CancelButton />
      </div>
    </div>
  );
}

function Sections() {
  const { view } = useReview();
  const c = view.commitment;
  const signed = view.answers !== null;
  // Re-seed the form whenever the saved record or commitment changes.
  const formKey = [
    view.stakeholderVersion,
    c?.id ?? "none",
    c?.committedCents ?? "",
    c?.signedOn ?? "",
    c?.investmentSummaryDate ?? "",
    c?.status ?? "",
  ].join("|");
  return (
    <div className="flex flex-col gap-4">
      <AnswersPanel />
      {signed ? (
        <>
          <DetailsForm key={formKey} />
          <ReceiptsSection />
          <DecisionSection />
        </>
      ) : null}
      <CountersignSection />
    </div>
  );
}

export function PacketReview({
  view,
  companyPublicId,
  managers,
  canReadDocuments,
}: {
  view: PacketView;
  companyPublicId: string;
  managers: ManagerOption[] | null;
  canReadDocuments: boolean;
}) {
  return (
    <ReviewProvider
      initialView={view}
      companyPublicId={companyPublicId}
      managers={managers}
      canReadDocuments={canReadDocuments}
    >
      <div className="flex flex-col gap-y-6">
        <Header />
        <Sections />
      </div>
    </ReviewProvider>
  );
}
