import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function CompliancePage() {
  await requireLlc();
  return <ComingSoon title="Compliance" owner="GOVERNANCE" />;
}
