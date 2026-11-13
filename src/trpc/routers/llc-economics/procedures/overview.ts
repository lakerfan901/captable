// Overview widget procedure (E19). Read only.
import { toDateOnly } from "@/lib/date-only";
import {
  computeAvailableCash,
  computeUnusedCapital,
  reserveBalances,
} from "@/lib/llc/available-cash";
import { addYears, compareIso, type IsoDate } from "@/lib/llc/dates";
import { managementFeeSummary } from "@/lib/llc/management-fee";
import {
  getCommitmentStates,
  getLineStates,
} from "@/server/llc/economics/call-notices";
import { economicsToday } from "@/server/llc/economics/clock";
import { getComplianceDates } from "@/server/llc/economics/compliance-dates";
import { nextComplianceDates } from "@/server/llc/economics/compliance-dates.logic";
import { nextDistributionDeadline } from "@/server/llc/economics/distributions.logic";
import {
  getOrgCapStatus,
  loadCashLedger,
} from "@/server/llc/economics/financials";
import { lastCompleteMonthEnd } from "@/server/llc/economics/financials.logic";
import { getPositions } from "@/server/llc/economics/ledger";
import { getTermClock } from "@/server/llc/economics/term";
import { toWire } from "@/server/llc/economics/wire";
import { withLlcAccessControl } from "@/trpc/api/trpc";

/** Far enough back to include every overdue date. */
const BEGINNING: IsoDate = "2000-01-01";

export const overviewProcedures = {
  overview: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const db = ctx.db;
      const companyId = ctx.membership.companyId;
      const today = economicsToday(ctx.company.timezone);

      // One cash ledger, one positions run, one set of line/commitment states,
      // shared by every card and by the compliance dates.
      const [
        cashLedger,
        { positions, config },
        lineStates,
        commitmentStates,
        orgCap,
        clock,
        feePayments,
        distributed,
        openDefaults,
      ] = await Promise.all([
        loadCashLedger(db, companyId),
        getPositions(db, companyId, today),
        getLineStates(db, companyId, today),
        getCommitmentStates(db, companyId),
        getOrgCapStatus(db, companyId),
        getTermClock(db, companyId),
        db.managerPayment.findMany({
          where: { companyId, category: "MANAGEMENT_FEE" },
          select: { paidOn: true, amountCents: true },
        }),
        db.distribution.aggregate({
          where: { companyId, status: "FINALIZED", isReversal: false },
          _sum: {
            tierCCents: true,
            tierDCents: true,
            tierEPreferredCents: true,
            tierECommonCents: true,
          },
        }),
        db.memberDefault.count({ where: { companyId, status: "OPEN" } }),
      ]);

      const complianceDates = await getComplianceDates(
        db,
        companyId,
        { from: BEGINNING, to: addYears(today, 6) },
        { cashLedger, lineStates, commitmentStates },
      );

      // Capital
      let committed = 0n;
      let paid = 0n;
      let uncalled = 0n;
      for (const c of commitmentStates) {
        committed += c.acceptedCents;
        paid += c.totalPaid;
        uncalled += c.uncalled;
      }
      let calledOutstanding = 0n;
      let openLines = 0;
      let overdueLines = 0;
      let nextDueOn: IsoDate | null = null;
      for (const l of lineStates) {
        if (
          (l.status !== "SENT" && l.status !== "SENDING") ||
          l.outstanding <= 0n
        ) {
          continue;
        }
        calledOutstanding += l.outstanding;
        openLines += 1;
        if (l.overdue) overdueLines += 1;
        if (
          l.dueOn !== null &&
          compareIso(l.dueOn, today) >= 0 &&
          (nextDueOn === null || compareIso(l.dueOn, nextDueOn) < 0)
        ) {
          nextDueOn = l.dueOn;
        }
      }

      // Cash (estimate as of the last complete month)
      const cashAsOf = lastCompleteMonthEnd(today);
      const available = computeAvailableCash(cashLedger, cashAsOf);
      const reserves = reserveBalances(cashLedger.reserves, today);
      const minimumReserve = config.minimumOperatingReserveCents;
      const minimumBalance =
        reserves.byKind.get("MINIMUM_OPERATING")?.total ?? 0n;

      // Management Fee to date
      const fee = managementFeeSummary(
        cashLedger.months,
        feePayments.map((p) => ({
          paidOn: toDateOnly(p.paidOn),
          amount: p.amountCents,
        })),
        { from: BEGINNING, to: today },
      );

      const s = distributed._sum;
      const distributedPeriodEnds = cashLedger.distributions
        .filter((x) => x.type !== "RETURN_OF_UNUSED_CAPITAL")
        .map((x) => x.on);

      return toWire({
        today,
        capital: {
          committed,
          paid,
          uncalled,
          calledOutstanding,
          unusedCapital: computeUnusedCapital(cashLedger, today).unusedCapital,
        },
        returns: {
          unreturnedCapital: positions.totals.unreturned,
          unpaidPreferredReturn: positions.totals.unpaidReturn,
          distributedToDate: {
            tierC: s.tierCCents ?? 0n,
            tierD: s.tierDCents ?? 0n,
            tierE: (s.tierEPreferredCents ?? 0n) + (s.tierECommonCents ?? 0n),
          },
        },
        cash: {
          asOf: cashAsOf,
          availableCash: available.availableCash,
          raw: available.raw,
          reserveBalance: reserves.total,
          minimumReserve,
          minimumMet: minimumBalance >= minimumReserve,
        },
        fee: { accruedToDate: fee.accruedToDate, unpaid: fee.unpaid },
        orgCap: { counted: orgCap.counted, limit: orgCap.limit },
        calls: { openLines, overdueLines, openDefaults, nextDueOn },
        nextDistribution: nextDistributionDeadline(
          today,
          config,
          distributedPeriodEnds,
        ),
        nextDeadlines: nextComplianceDates(complianceDates, today, 5),
        term: {
          ocd: clock.operationsCommencementDate,
          effectiveTargetSaleDate: clock.effectiveTargetSaleDate,
          extensionRequestDueOn: clock.extensionRequestDueOn,
        },
      });
    }),
};
