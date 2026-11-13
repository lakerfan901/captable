// Scenario S — shared test fixture (02-economics.md D.0). Imported only by tests.

import { type LlcEconomicsConfig, OA_DEFAULTS } from "../config";
import type { MicroUnits } from "../money";
import type { ContributionEvent } from "../positions";
import {
  type AllocationRow,
  buildCapitalLots,
  type ReceiptRow,
} from "../preferred-return";

/** 8% (800 bps), basis 365, $1,000 per unit, 70/30. */
export const SCENARIO_S_CONFIG: LlcEconomicsConfig = {
  ...OA_DEFAULTS,
  prefReturnBps: 800,
  dayCountBasis: 365,
  pricePerUnitCents: 100_000n,
  residualPreferredBps: 7000,
  capitalReturnLotOrder: "PRO_RATA",
};

const U = 1_000_000n;

export const SCENARIO_S_RECEIPTS: readonly ReceiptRow[] = [
  {
    receiptId: "a1",
    holderId: "A",
    kind: "INITIAL",
    on: "2026-11-16",
    receivedOn: "2026-11-16",
    amount: 10_000_000n,
    units: 100n * U,
    prefReturnStartOn: "2026-11-16",
    seq: 1,
  },
  {
    receiptId: "b1",
    holderId: "B",
    kind: "INITIAL",
    on: "2026-11-23",
    receivedOn: "2026-11-23",
    amount: 25_000_000n,
    units: 250n * U,
    prefReturnStartOn: "2026-11-23",
    seq: 2,
  },
  {
    receiptId: "c1",
    holderId: "C",
    kind: "INITIAL",
    on: "2026-11-30",
    receivedOn: "2026-11-30",
    amount: 4_000_000n,
    units: 40n * U,
    prefReturnStartOn: "2026-11-30",
    seq: 3,
  },
  {
    receiptId: "c2",
    holderId: "C",
    kind: "BALANCE",
    on: "2027-01-19",
    receivedOn: "2027-01-19",
    amount: 6_000_000n,
    units: 60n * U,
    prefReturnStartOn: "2027-01-20",
    seq: 4,
  },
];

/** c2 is allocated in full to a Call Notice line due 2027-01-20. */
export const SCENARIO_S_ALLOCATIONS: readonly AllocationRow[] = [
  { receiptId: "c2", amount: 6_000_000n, prefReturnStartOn: "2027-01-20" },
];

export const SCENARIO_S_EVENTS: readonly ContributionEvent[] = buildCapitalLots(
  SCENARIO_S_RECEIPTS,
  SCENARIO_S_ALLOCATIONS,
);

/** Common holders (no capital, no Preferred Return). */
export const SCENARIO_S_COMMON: readonly {
  holderId: string;
  units: MicroUnits;
}[] = [{ holderId: "M", units: 100n * U }];
