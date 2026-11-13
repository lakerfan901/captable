import { Badge } from "@/components/ui/badge";
import type { PacketStage } from "@/lib/admission/packet-stage";

// The stage of an Exhibit B packet (01-foundation.md F12).

export const PACKET_STAGE_LABELS: Record<PacketStage, string> = {
  AWAITING_INVESTOR: "Awaiting investor",
  AWAITING_REVIEW: "Awaiting review",
  AWAITING_COUNTERSIGN: "Awaiting countersignature",
  FINALISING: "Finalising",
  COMPLETE: "Complete",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
};

const VARIANTS = {
  AWAITING_INVESTOR: "secondary",
  AWAITING_REVIEW: "warning",
  AWAITING_COUNTERSIGN: "warning",
  FINALISING: "info",
  COMPLETE: "success",
  CANCELLED: "outline",
  REJECTED: "destructive",
} as const satisfies Record<PacketStage, string>;

export function PacketStageBadge({ stage }: { stage: PacketStage }) {
  return <Badge variant={VARIANTS[stage]}>{PACKET_STAGE_LABELS[stage]}</Badge>;
}
