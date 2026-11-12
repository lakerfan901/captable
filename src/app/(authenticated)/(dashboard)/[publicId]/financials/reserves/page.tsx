import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function ReservesPage() {
  await requireLlc();
  return <ComingSoon title="Reserves" owner="ECONOMICS" />;
}
