import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function DistributionsPage() {
  await requireLlc();
  return <ComingSoon title="Distributions" owner="ECONOMICS" />;
}
