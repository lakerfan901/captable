import EmptyState from "@/components/common/empty-state";

export function ComingSoon({
  title,
  owner,
}: {
  title: string;
  owner: "FOUNDATION" | "ECONOMICS" | "GOVERNANCE";
}) {
  return (
    <div data-owner={owner}>
      <EmptyState title={title} subtitle="This section is being built." />
    </div>
  );
}
