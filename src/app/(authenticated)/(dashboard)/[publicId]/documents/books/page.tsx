import { ComingSoon } from "@/components/llc/coming-soon";
import { requireLlc } from "@/server/entity";

export default async function BooksPage() {
  await requireLlc();
  return <ComingSoon title="Books and records" owner="GOVERNANCE" />;
}
