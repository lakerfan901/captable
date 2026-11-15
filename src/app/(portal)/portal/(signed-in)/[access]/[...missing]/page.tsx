import { notFound } from "next/navigation";

// Any path under `/portal/[access]/` that no page claims (package P8a): the
// portal's own 404 rather than the team app's. Real sections (P8b, P15) are
// more specific routes and win over this one. The [access] layout has
// already resolved the access (or answered 404 itself).

export default function PortalAccessMissingPage() {
  notFound();
}
