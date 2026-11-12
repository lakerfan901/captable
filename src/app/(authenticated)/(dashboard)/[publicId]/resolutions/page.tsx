import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function ResolutionsPage() {
  await requireLlc();
  return <ComingSoon title="Resolutions" owner="GOVERNANCE" />;
}
