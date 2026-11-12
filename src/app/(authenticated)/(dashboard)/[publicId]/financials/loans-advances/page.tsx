import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function LoansAdvancesPage() {
  await requireLlc();
  return <ComingSoon title="Loans and advances" owner="ECONOMICS" />;
}
