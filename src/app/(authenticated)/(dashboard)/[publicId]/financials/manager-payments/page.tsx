import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function ManagerPaymentsPage() {
  await requireLlc();
  return <ComingSoon title="Manager payments" owner="ECONOMICS" />;
}
