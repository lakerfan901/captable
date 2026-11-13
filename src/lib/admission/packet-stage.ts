// The stage of an Exhibit B packet (01-foundation.md F12). Pure: no imports,
// unit-tested. Derived from the template, its two role recipients and the
// commitment the Manager created on the confirmation screen (F13).

export type PacketTemplateStatus =
  | "DRAFT"
  | "PENDING"
  | "COMPLETE"
  | "CANCELLED";
export type PacketRecipientStatus = "PENDING" | "SENT" | "SIGNED";
export type PacketCommitmentStatus =
  | "PENDING"
  | "ACCEPTED"
  | "REDUCED"
  | "REJECTED";

export const PACKET_STAGES = [
  "AWAITING_INVESTOR",
  "AWAITING_REVIEW",
  "AWAITING_COUNTERSIGN",
  "FINALISING",
  "COMPLETE",
  "CANCELLED",
  "REJECTED",
] as const;

export type PacketStage = (typeof PACKET_STAGES)[number];

/** Stages in which a packet still waits for someone (one per stakeholder). */
export const OPEN_PACKET_STAGES: readonly PacketStage[] = [
  "AWAITING_INVESTOR",
  "AWAITING_REVIEW",
  "AWAITING_COUNTERSIGN",
];

export interface PacketStageInput {
  templateStatus: PacketTemplateStatus;
  /** null when the packet has no investor recipient (never for a clone). */
  investorStatus: PacketRecipientStatus | null;
  managerStatus: PacketRecipientStatus | null;
  commitmentStatus: PacketCommitmentStatus | null;
}

export function packetStage(input: PacketStageInput): PacketStage {
  const { templateStatus, investorStatus, managerStatus, commitmentStatus } =
    input;

  if (commitmentStatus === "REJECTED") return "REJECTED";
  if (templateStatus === "CANCELLED") return "CANCELLED";
  if (templateStatus === "COMPLETE") return "COMPLETE";
  if (investorStatus !== "SIGNED") return "AWAITING_INVESTOR";
  // The Manager has countersigned; the PDF job completes the template.
  if (managerStatus === "SIGNED") return "FINALISING";
  if (commitmentStatus === null || commitmentStatus === "PENDING") {
    return "AWAITING_REVIEW";
  }
  return "AWAITING_COUNTERSIGN";
}
