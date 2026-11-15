import { requirePortalHolder } from "@/components/portal/portal-me";

// /portal/[access], the Overview of one holder (04-investor-portal.md 6.3).
// Package P8a ships the route and its gate so the chooser, the switcher and
// the one-holder redirect have somewhere to go; the frame (holder header,
// switcher, tab row) is the layout. The Overview's content (published-
// through date, KPI tiles, charts, latest report, newest documents) is
// package P15, which replaces this page body; until then nothing is shown
// that has no data behind it.

export default async function PortalAccessOverviewPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  // The gate again: the layout is not re-run on every navigation.
  await requirePortalHolder(access);
  return null;
}
