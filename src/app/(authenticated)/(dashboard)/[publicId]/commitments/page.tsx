import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function CommitmentsPage() {
  await requireLlc();
  return <ComingSoon title="Commitments" owner="FOUNDATION" />;
}
