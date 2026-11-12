import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function FairValuePage() {
  await requireLlc();
  return <ComingSoon title="Fair value" owner="ECONOMICS" />;
}
