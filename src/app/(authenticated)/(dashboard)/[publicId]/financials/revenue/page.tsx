import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function RevenuePage() {
  await requireLlc();
  return <ComingSoon title="Revenue" owner="ECONOMICS" />;
}
