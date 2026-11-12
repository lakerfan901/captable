import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function CapitalCallsPage() {
  await requireLlc();
  return <ComingSoon title="Capital calls" owner="ECONOMICS" />;
}
