import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function UnitClassesPage() {
  await requireLlc();
  return <ComingSoon title="Unit classes" owner="FOUNDATION" />;
}
