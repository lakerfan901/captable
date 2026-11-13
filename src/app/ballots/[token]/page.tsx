import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  BallotForm,
  ExecutedConsentButton,
} from "@/components/governance/ballot-form";
import { RichDocView } from "@/components/governance/rich-doc-view";
import { SharePageLayout } from "@/components/share/page-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatDateOnly } from "@/lib/date-only";
import type { RichDoc } from "@/lib/governance/rich-doc";
import { api } from "@/trpc/server";

// Public ballot page (03-governance.md G11): what a Member opens from the
// emailed link, without logging in. The token in the path is the only
// credential. It is passed to `ballot.view` (server side, read-only) and to
// the client `BallotForm`, which makes the evidence-bearing calls from the
// browser. It is never logged or rendered. `no-referrer` keeps it out of the
// Referer of every request this page makes (logo, links, the PDF). Every
// public ballot procedure is a mutation, so the token is never put in a URL
// by a tRPC call. Dates are shown in the company's time zone (from `view`).

export const metadata: Metadata = {
  title: "Member consent",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type View = Awaited<ReturnType<typeof api.ballot.view>>;
type OkView = Exclude<View, { state: "REPLACED" }>;

function formatInstant(at: Date | string | null, timeZone: string): string {
  if (at === null) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "long",
    timeStyle: "short",
  }).format(d);
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  return `${text} ${zone}`;
}

function formatUnits(units: string): string {
  const [int = "0", frac] = units.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

const CHOICE_TEXT: Record<string, string> = {
  FOR: "For",
  AGAINST: "Against",
  ABSTAIN: "Abstain",
};

function Facts({ view }: { view: OkView }) {
  const { resolution, ballot } = view;
  return (
    <dl className="space-y-2 rounded-md border bg-muted/40 p-4 text-sm">
      <div>
        <dt className="inline text-muted-foreground">Member: </dt>
        <dd className="inline font-medium">{ballot.name}</dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">
          Preferred Units of record on{" "}
          {resolution.recordDate ? formatDateOnly(resolution.recordDate) : "—"}:{" "}
        </dt>
        <dd className="inline font-medium tabular-nums">
          {formatUnits(ballot.preferredUnits)}
        </dd>
      </div>
      {view.state !== "CLOSED" ? (
        <div>
          <dt className="inline text-muted-foreground">Respond by </dt>
          <dd className="inline font-medium">
            {formatInstant(resolution.closesAt, view.timeZone)}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Document({
  doc,
  lockedClauses,
}: {
  doc: RichDoc;
  lockedClauses: string[];
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">The resolution</h2>
      <div className="break-words">
        <RichDocView doc={doc} />
      </div>
      {lockedClauses.length > 0 ? (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          {lockedClauses.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: frozen text, never reordered
            <li key={i}>{c}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function signature(ballot: OkView["ballot"]): string {
  return `${ballot.signedName ?? ""}${ballot.signerCapacity ? `, ${ballot.signerCapacity}` : ""}`;
}

function OwnResponse({ view }: { view: OkView }) {
  const { ballot } = view;
  if (ballot.deemed) {
    return (
      <p>
        No response was received within 30 days. Under Section 2.5 you are
        deemed to have voted against the extension.
      </p>
    );
  }
  if (ballot.choice === null || ballot.submittedAt === null) {
    return <p>You did not respond.</p>;
  }
  return (
    <p>
      Your response was recorded on{" "}
      {formatInstant(ballot.submittedAt, view.timeZone)}:{" "}
      <span className="font-semibold">
        {CHOICE_TEXT[ballot.choice] ?? ballot.choice}
      </span>
      . Signed: {signature(ballot)}.
    </p>
  );
}

function ClosedBanner({
  view,
  token,
}: {
  view: OkView;
  token: string;
}): ReactNode {
  const r = view.resolution;
  const at = (d: Date | string | null) => formatInstant(d, view.timeZone);
  switch (r.status) {
    case "EFFECTIVE":
      return (
        <Alert className="border-green-300 bg-green-50">
          <AlertTitle>Approved. Effective {at(r.effectiveAt)}.</AlertTitle>
          {r.hasExecutedPdf ? (
            <AlertDescription className="mt-3">
              <ExecutedConsentButton token={token} />
            </AlertDescription>
          ) : null}
        </Alert>
      );
    case "FAILED":
      return (
        <Alert variant="destructive">
          <AlertTitle>Not approved.</AlertTitle>
          {r.closedAt ? (
            <AlertDescription>
              Voting closed on {at(r.closedAt)}.
            </AlertDescription>
          ) : null}
        </Alert>
      );
    case "EXPIRED":
      return (
        <Alert variant="destructive">
          <AlertTitle>
            Closed on {at(r.closedAt)} without the required approval.
          </AlertTitle>
        </Alert>
      );
    case "WITHDRAWN":
      return (
        <Alert>
          <AlertTitle>Withdrawn by the Manager on {at(r.closedAt)}.</AlertTitle>
          {r.withdrawnReason ? (
            <AlertDescription>Reason: {r.withdrawnReason}</AlertDescription>
          ) : null}
        </Alert>
      );
    default:
      return (
        <Alert>
          <AlertTitle>Voting on this resolution has closed.</AlertTitle>
        </Alert>
      );
  }
}

export default async function BallotPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const data = await api.ballot.view({ token }).catch(() => null);
  if (!data) return notFound();

  if (data.state === "REPLACED") {
    return (
      <SharePageLayout
        medium="ballot"
        company={data.company}
        title={
          <h1 className="text-2xl font-semibold tracking-tight">
            Member consent
          </h1>
        }
      >
        <p className="text-base">
          This link has been replaced. Please use the most recent email from{" "}
          {data.company.name}, or contact the Manager.
        </p>
      </SharePageLayout>
    );
  }

  const { resolution, ballot } = data;
  const consentOnly = !ballot.countsPreferred && !ballot.countsDisinterested;

  return (
    <SharePageLayout
      medium="ballot"
      company={data.company}
      title={
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight break-words">
            {resolution.title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {resolution.kindLabel}
            {resolution.referenceCode ? ` · ${resolution.referenceCode}` : ""}
          </p>
        </div>
      }
    >
      <div className="space-y-6 text-base">
        {data.state === "CLOSED" ? (
          <ClosedBanner view={data} token={token} />
        ) : null}

        <Facts view={data} />

        {consentOnly && data.state === "OPEN" ? (
          <p className="text-sm">
            Your consent is requested as an affected Member (Section 12.1(b)).
          </p>
        ) : null}

        {resolution.hasDisinterestedRequirement &&
        ballot.countsPreferred &&
        !ballot.countsDisinterested ? (
          <p className="text-sm">
            Your units are not counted toward the Disinterested vote (Section
            1.18).
          </p>
        ) : null}

        {data.state === "VOTED" ? (
          <Alert className="border-green-300 bg-green-50">
            <AlertDescription className="space-y-2 text-base text-foreground">
              <OwnResponse view={data} />
              <p>The result will be emailed to all Members.</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {data.state === "CLOSED" ? (
          <section className="space-y-1">
            <h2 className="text-base font-semibold">Your response</h2>
            <OwnResponse view={data} />
          </section>
        ) : null}

        <Document
          doc={resolution.doc}
          lockedClauses={resolution.lockedClauses}
        />

        {data.state === "OPEN" ? (
          <BallotForm
            token={token}
            frozenHash={resolution.frozenHash}
            memberName={ballot.name}
            deemedAgainstAtClose={resolution.deemedAgainstAtClose}
          />
        ) : null}
      </div>
    </SharePageLayout>
  );
}
