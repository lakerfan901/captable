import { PortalDocumentList } from "@/components/portal/document-list";
import { portalPageCall } from "@/components/portal/portal-call";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalSectionHeading } from "@/components/portal/section-heading";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { api } from "@/trpc/server";

// /portal/[access]/documents (04-investor-portal.md 6.1; package P8b): the
// documents shared with this holder (P13, P14), newest share first, through
// `portal.documents.list`. "Open" and "Download" request a 60-second URL
// from the browser at the moment they are pressed (`PortalFileButton`).

export default async function PortalDocumentsPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  const { holder } = await requirePortalHolder(access);
  const [documents, home] = await Promise.all([
    portalPageCall(() => api.portal.documents.list({ access })),
    portalPageCall(() => api.portal.home({ access })),
  ]);
  return (
    <section
      className="flex flex-col gap-y-3"
      aria-labelledby="documents-title"
    >
      <PortalSectionHeading
        title="Documents"
        id="documents-title"
        description={`Documents shared with ${holder.holderName}`}
      />
      <PortalDocumentList
        access={access}
        timeZone={home.timeZone || GOVERNANCE_TIME_ZONE}
        documents={documents.map((d) => ({
          id: d.id,
          name: d.name,
          sharedAt: d.sharedAt,
          inline: d.inline,
          sizeBytes: d.sizeBytes,
          category: d.category,
        }))}
      />
    </section>
  );
}
