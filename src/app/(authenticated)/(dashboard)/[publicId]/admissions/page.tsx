import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function AdmissionsPage() {
  await requireLlc();
  return <ComingSoon title="Admissions" owner="FOUNDATION" />;
}
