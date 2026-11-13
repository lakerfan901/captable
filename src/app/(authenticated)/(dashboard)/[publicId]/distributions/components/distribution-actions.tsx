"use client";

import type { DistributionStatusValue } from "./distribution-table";

/** Slot for E17 (notices, CSV export, payment marking); renders nothing until E17 fills it. */
export function DistributionActions(_props: {
  distributionId: string;
  status: DistributionStatusValue;
}) {
  return null;
}
