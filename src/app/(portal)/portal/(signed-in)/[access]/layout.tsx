import type { ReactNode } from "react";
import { HolderHeader } from "@/components/portal/holder-header";
import { loadPortalFinancials } from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalNav } from "@/components/portal/portal-nav";
import { PortalShell } from "@/components/portal/portal-shell";
import { type PortalSectionKey, portalNavItems } from "@/lib/portal/portal-nav";

// /portal/[access]/… (04-investor-portal.md 6.1, 6.3; package P8a): the
// frame of one holder. `[access]` is the opaque `PortalAccess.publicId`
// (S25); it is resolved against the signed-in user on every request and a
// value that is not one of that user's ACTIVE accesses is a 404 (P10, S3).
// A layout is not re-run when the browser moves between pages of the same
// access, so every page under it calls `requirePortalHolder` (or an
// `investorProcedure`) itself; `portal.me` is read once per request.
//
// The tab row lists only sections whose page exists (`portalNavItems`); the
// "Viewing" switcher appears when the person has more than one holder.

export default async function PortalAccessLayout(props: {
  children: ReactNode;
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  const { me, holder } = await requirePortalHolder(access);
  // 6.3: with no published period, Financials and My investment are not in
  // the tab row (their pages show the empty state when opened directly).
  const financials = await loadPortalFinancials(holder.access);
  const hide: PortalSectionKey[] =
    financials.publishedThrough === null ? ["financials", "investment"] : [];
  return (
    <PortalShell email={me.email}>
      <div className="flex flex-col gap-6">
        <PortalNav items={portalNavItems(holder.access, { hide })} />
        <HolderHeader
          current={{
            access: holder.access,
            holderName: holder.holderName,
            companyName: holder.companyName,
            companyLogo: holder.companyLogo,
          }}
          holders={me.holders.map((h) => ({
            access: h.access,
            holderName: h.holderName,
            companyName: h.companyName,
          }))}
        />
        {props.children}
      </div>
    </PortalShell>
  );
}
