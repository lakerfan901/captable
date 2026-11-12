import { requireCorporation } from "@/server/entity";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireCorporation();
  return children;
}
