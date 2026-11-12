import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function TransfersPage() {
  await requireLlc();
  return <ComingSoon title="Transfers" owner="GOVERNANCE" />;
}
