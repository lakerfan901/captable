import type { Metadata } from "next";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { LoiForm } from "./components/loi-form";
import { OcdForm } from "./components/ocd-form";
import { ParametersForm } from "./components/parameters-form";
import { SwitchesForm } from "./components/switches-form";
import { TermClockCard } from "./components/term-clock-card";

export const metadata: Metadata = {
  title: "Term clock and agreement parameters",
};

export default async function LlcTermPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const data = await allow(api.llcTerm.get(), ["llc-terms", "read"]);

  if (!data) {
    return <UnAuthorizedState />;
  }

  const canEdit = allow(true, ["llc-terms", "update"], false);
  const canReadDocuments = allow(true, ["documents", "read"], false);
  const documents = canReadDocuments
    ? (await api.document.getAll()).map((d) => ({ id: d.id, name: d.name }))
    : [];
  const unitClassesHref = `/${entity.publicId}/unit-classes`;

  return (
    <div className="flex flex-col gap-y-6">
      <div>
        <h3 className="font-medium">Term clock and agreement parameters</h3>
        <p className="text-sm text-muted-foreground">
          Dates, parameters and interpretation switches of the Operating
          Agreement used by Call Notices, defaults and distributions.
        </p>
      </div>

      {data.unitClassTerms === null ? (
        <Alert variant="destructive">
          <AlertDescription>
            The company has no Preferred unit class.{" "}
            <Link className="underline" href={unitClassesHref}>
              Open unit classes
            </Link>
          </AlertDescription>
        </Alert>
      ) : data.unitClassTerms.balanceOutsideDate === null ? (
        <Alert>
          <AlertDescription>
            The Balance outside date (Section 4.9) is not set. Call Notices and
            Balance payments need it.{" "}
            <Link className="underline" href={unitClassesHref}>
              Set it on the Preferred unit class
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <TermClockCard
        clock={data.clock}
        today={data.today}
        ocdNoticeSentOn={data.term.ocdNoticeSentOn}
      />
      <OcdForm
        operationsCommencementDate={data.term.operationsCommencementDate}
        ocdNoticeSentOn={data.term.ocdNoticeSentOn}
        today={data.today}
        extensionsApproved={data.extensionsApproved}
        canEdit={canEdit}
      />
      <LoiForm
        days={data.term.loiExtensionDays}
        loiDocumentId={data.term.loiDocumentId}
        maxDays={data.term.loiExtensionMaxDays}
        hasOcd={data.term.operationsCommencementDate !== null}
        documents={documents}
        canEdit={canEdit}
      />
      <ParametersForm
        term={data.term}
        unitClassTerms={data.unitClassTerms}
        unitClassesHref={unitClassesHref}
        locked={data.economicsLocked}
        canEdit={canEdit}
      />
      <SwitchesForm
        term={data.term}
        locked={data.economicsLocked}
        canEdit={canEdit}
      />
    </div>
  );
}
