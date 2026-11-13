import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { ResolutionStatus } from "@/trpc/routers/resolution-router/schema";

// Resolution status badge (03-governance.md G10).

const STATUS: Record<
  ResolutionStatus,
  { label: string; variant: NonNullable<BadgeProps["variant"]> }
> = {
  DRAFT: { label: "Draft", variant: "warning" },
  SENT: { label: "Open for responses", variant: "secondary" },
  EFFECTIVE: { label: "Effective", variant: "success" },
  FAILED: { label: "Not approved", variant: "destructive" },
  EXPIRED: { label: "Expired", variant: "destructive" },
  WITHDRAWN: { label: "Withdrawn", variant: "outline" },
};

export function statusLabel(status: string): string {
  return STATUS[status as ResolutionStatus]?.label ?? status;
}

export function StatusBadge({
  status,
  className,
}: {
  status: ResolutionStatus | string;
  className?: string;
}) {
  const s = STATUS[status as ResolutionStatus] ?? {
    label: status,
    variant: "secondary" as const,
  };
  return (
    <Badge variant={s.variant} className={className}>
      {s.label}
    </Badge>
  );
}
