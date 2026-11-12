import { Badge } from "@/components/ui/badge";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";

const LABELS: Record<CommitmentDTO["status"], string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  REDUCED: "Reduced",
  REJECTED: "Rejected",
};

const VARIANTS = {
  PENDING: "warning",
  ACCEPTED: "success",
  REDUCED: "info",
  REJECTED: "destructive",
} as const;

export function CommitmentStatusBadge({
  status,
}: {
  status: CommitmentDTO["status"];
}) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>;
}
