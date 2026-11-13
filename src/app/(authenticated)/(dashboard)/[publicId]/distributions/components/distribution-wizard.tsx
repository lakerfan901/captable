"use client";

import { RiCheckLine } from "@remixicon/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";
import type { ZDistributionInputsSchema } from "@/trpc/routers/distribution/schema";
import type { DistributionTypeValue } from "./distribution-table";
import { StepFinalize } from "./step-finalize";
import { StepInputs } from "./step-inputs";
import { StepReview } from "./step-review";
import { StepSetup } from "./step-setup";

export type DistributionInputsValue = z.infer<typeof ZDistributionInputsSchema>;

export interface DraftValue {
  id: string;
  type: DistributionTypeValue;
  periodStart: string | null;
  periodEnd: string;
  paymentDate: string;
  inputs: DistributionInputsValue;
  notes: string | null;
}

export type WizardStep = "setup" | "inputs" | "review" | "finalize";

const STEPS: { key: WizardStep; title: string }[] = [
  { key: "setup", title: "Setup" },
  { key: "inputs", title: "Inputs" },
  { key: "review", title: "Review" },
  { key: "finalize", title: "Finalize" },
];

/** Horizontal step indicator after `src/components/ui/stepper.tsx`. */
function StepIndicator({ current }: { current: number }) {
  return (
    <nav aria-label="Progress">
      <ol className="flex flex-wrap items-center gap-6">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className="flex items-center gap-2"
            {...(i === current && { "aria-current": "step" as const })}
          >
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full",
                i === current && "border-2 border-teal-500 bg-white",
                i > current && "border-2 border-gray-300 bg-white",
                i < current && "bg-teal-500",
              )}
            >
              {i < current ? (
                <RiCheckLine className="h-4 w-4 text-white" aria-hidden />
              ) : (
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    i === current && "bg-teal-500",
                  )}
                />
              )}
            </span>
            <span
              className={cn(
                "text-sm font-medium",
                i === current && "text-teal-500",
                i > current && "text-gray-500",
              )}
            >
              {s.title}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function DistributionWizard({
  base,
  companyBase,
  today,
  draft,
  step: requested,
  conflict,
  canCreate,
  canUpdate,
  canDelete,
  canReadFinancials,
}: {
  base: string;
  companyBase: string;
  today: string;
  draft: DraftValue | null;
  step: WizardStep;
  conflict: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canReadFinancials: boolean;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = api.distribution.saveDraft.useMutation();
  const remove = api.distribution.deleteDraft.useMutation();

  const step: WizardStep = draft === null ? "setup" : requested;
  const compute = api.distribution.compute.useQuery(
    { id: draft?.id ?? "" },
    {
      enabled: draft !== null && step !== "setup",
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );
  const c = compute.data;

  const isLiquidation =
    draft?.inputs.type === "SALE_OR_LIQUIDATION" &&
    draft.inputs.liquidation !== null;
  const needsFee =
    canReadFinancials &&
    isLiquidation &&
    draft?.inputs.type === "SALE_OR_LIQUIDATION" &&
    (draft.inputs.liquidation?.creditors.length ?? 0) === 0;
  const summary = api.llcFinancials.summary.useQuery(
    {},
    { enabled: needsFee && step === "inputs", retry: false },
  );
  const unpaidFee = summary.data?.fee.toDate.unpaid ?? null;

  const hrefFor = (s: WizardStep) =>
    draft ? `${base}/${draft.id}?step=${s}` : `${base}/new`;

  // A direct ?step=finalize cannot bypass the blockers or the permission.
  const effective: WizardStep =
    step === "finalize" && (!canUpdate || !c || c.blockers.length > 0)
      ? "review"
      : step;
  const current = STEPS.findIndex((s) => s.key === effective);

  /** Saves the draft; true when saved (a failure is shown and returns false). */
  const persist = async (
    v: Omit<DraftValue, "id">,
    next: WizardStep | null,
  ): Promise<boolean> => {
    setSaveError(null);
    try {
      const r = await save.mutateAsync({
        id: draft?.id,
        type: v.type,
        periodStart: v.periodStart,
        periodEnd: v.periodEnd,
        paymentDate: v.paymentDate,
        inputs: v.inputs,
        notes: v.notes,
      });
      toast.success("Draft saved.");
      await utils.distribution.compute.invalidate({ id: r.id });
      if (next) router.push(`${base}/${r.id}?step=${next}`);
      router.refresh();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
      toast.error(message);
      return false;
    }
  };

  const deleteDraft = async () => {
    if (!draft) return;
    if (!window.confirm("Delete this draft distribution?")) return;
    try {
      await remove.mutateAsync({ id: draft.id });
      toast.success("Draft deleted.");
      router.push(base);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <StepIndicator current={current} />
        {draft && canDelete ? (
          <Button
            variant="outline"
            size="sm"
            onClick={deleteDraft}
            loading={remove.isPending}
          >
            Delete draft
          </Button>
        ) : null}
      </div>

      {effective === "setup" ? (
        canCreate ? (
          <StepSetup
            key={draft?.id ?? "new"}
            today={today}
            draft={draft}
            saving={save.isPending}
            error={saveError}
            onSave={(v) => void persist(v, "inputs")}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            You do not have permission to edit distributions.
          </p>
        )
      ) : null}

      {draft && effective !== "setup" && compute.error ? (
        <Alert variant="destructive">
          <AlertTitle>This draft cannot be computed</AlertTitle>
          <AlertDescription>
            {compute.error.message}{" "}
            <Link className="underline" href={hrefFor("setup")}>
              Review the setup
            </Link>{" "}
            or{" "}
            <Link
              className="underline"
              href={`${companyBase}/unit-classes`}
              target="_blank"
              rel="noreferrer"
            >
              open unit classes
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      {draft && effective === "inputs" ? (
        needsFee && summary.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <StepInputs
            key={`${draft.id}-${draft.inputs.type}`}
            draft={draft}
            computation={c}
            companyBase={companyBase}
            unpaidFee={unpaidFee}
            saving={save.isPending}
            saveError={saveError}
            recalculating={compute.isFetching}
            onRecalculate={() => void compute.refetch()}
            onSaveInputs={
              canCreate
                ? (inputs, opts) =>
                    persist(
                      { ...draft, inputs },
                      opts?.thenReview ? "review" : null,
                    )
                : null
            }
            setupHref={hrefFor("setup")}
            onContinue={() => router.push(hrefFor("review"))}
          />
        )
      ) : null}

      {draft && effective === "review" ? (
        c ? (
          <StepReview
            computation={c}
            companyBase={companyBase}
            stepHref={hrefFor}
            conflict={conflict}
            canFinalize={canUpdate}
            onRecalculate={() => void compute.refetch()}
            recalculating={compute.isFetching}
            onContinue={() => router.push(hrefFor("finalize"))}
          />
        ) : compute.isLoading ? (
          <p className="text-sm text-muted-foreground">Computing…</p>
        ) : null
      ) : null}

      {draft && effective === "finalize" && c ? (
        <StepFinalize
          distributionId={draft.id}
          computation={c}
          reviewHref={hrefFor("review")}
          onFinalized={() => {
            toast.success("Distribution finalized.");
            router.replace(`${base}/${draft.id}`);
            router.refresh();
          }}
          onConflict={() => {
            router.push(`${hrefFor("review")}&conflict=1`);
            void compute.refetch();
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
