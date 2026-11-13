/**
 * LOCAL DEVELOPMENT ONLY (03-governance.md G19 "Seed"): a test LLC holding
 * the register `REG` of G1, built through the real FOUNDATION / ECONOMICS
 * services, plus one DRAFT general consent, one SENT related-party
 * resolution with alice FOR, and one EFFECTIVE purchase-order resolution,
 * built through the real resolution and ballot routers.
 *
 * Called from `prisma/seeds/index.ts` only when NODE_ENV is "test" (the
 * `db:seed` script sets it); refuses NODE_ENV=production itself as well.
 * Server modules import `server-only`, so the caller loads
 * `./server-only-hook.mjs` before importing this file.
 *
 * | stakeholder | Preferred | flags                                   |
 * |-------------|-----------|-----------------------------------------|
 * | alice       | 400       |                                         |
 * | bob         | 300       |                                         |
 * | carol       | 150       |                                         |
 * | dan         | 50.5      | fractional                              |
 * | schoen      | 100       | insider                                 |
 * | reidTrust   | 49.5      | insider                                 |
 * | sam         | 200       | suspended: Balance called, default declared |
 * | fay         | 75        | Financial Interest only                 |
 * | octagon     | 0         | insider, 100 Common Units               |
 *
 * Economics "today" is pinned with LLC_ECONOMICS_TODAY while the ledger is
 * built (October 2026, before the Final Closing Date) and restored after.
 * Resolutions use the real date. Every address is `@example.com`. Sending a
 * Call Notice and a resolution writes email jobs; with no mail catcher
 * configured, sam is left unsuspended (reported on the console).
 */
import { randomUUID } from "node:crypto";
import colors from "colors";
import type { Session } from "next-auth";
import { generatePublicId } from "@/common/id";
import { todayInZone } from "@/lib/governance/dates";
import { addDays } from "@/lib/llc/dates";
import { callNoticeDueDate } from "@/lib/llc/default";
import { queue } from "@/lib/queue";
import { db } from "@/server/db";
import { signBallotToken } from "@/server/governance/tokens";
import {
  createCommitment,
  decideCommitment,
  issueCommonUnits,
  type LedgerActor,
  recordCapitalReceipt,
} from "@/server/llc/commitments";
import {
  saveCallNoticeDraft,
  sendCallNotice,
} from "@/server/llc/economics/call-notices";
import { declareDefault } from "@/server/llc/economics/defaults";
import { getEconomicsContext } from "@/server/llc/economics/term";
import { createCallerFactory } from "@/trpc/api/trpc";
import { ballotRouter } from "@/trpc/routers/ballot-router/router";
import { resolutionRouter } from "@/trpc/routers/resolution-router/router";

colors.enable();

const TX = { timeout: 60_000, maxWait: 10_000 } as const;
const TIME_ZONE = "America/Denver";
const SIGNED_ON = "2026-10-01";
const RECEIVED_ON = "2026-10-05";
const CALL_SENT_ON = "2026-10-15";

const REG: {
  key: string;
  name: string;
  units: number; // Preferred Units = dollars / 1,000
  isInsider?: boolean;
  financialInterestOnly?: boolean;
  defaulting?: boolean;
}[] = [
  { key: "alice", name: "Alice Anders", units: 400 },
  { key: "bob", name: "Bob Barrett", units: 300 },
  { key: "carol", name: "Carol Chen", units: 150 },
  { key: "dan", name: "Dan Dorsey", units: 50.5 },
  { key: "schoen", name: "Schoen Holdings", units: 100, isInsider: true },
  { key: "reidTrust", name: "Reid Family Trust", units: 49.5, isInsider: true },
  { key: "sam", name: "Sam Sutter", units: 200, defaulting: true },
  { key: "fay", name: "Fay Fischer", units: 75, financialInterestOnly: true },
];

const usd = (dollars: number) => BigInt(Math.round(dollars * 100));

function setEconomicsToday(day: string | null) {
  if (day === null) delete process.env.LLC_ECONOMICS_TODAY;
  else process.env.LLC_ECONOMICS_TODAY = day;
}

/** The team user the resolutions are authored by (seedTeam's CEO). */
async function waitForUser(email: string) {
  for (let i = 0; i < 50; i++) {
    const user = await db.user.findUnique({ where: { email } });
    if (user) return user;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Seed: team user ${email} was not created.`);
}

export async function seedLlcGovernance(
  opts: { name?: string; managerEmail?: string } = {},
) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The LLC governance seed never runs in production.");
  }
  const name = opts.name ?? "Octagon Seed LLC";
  console.log(`Seeding the LLC governance register (${name})`.blue);

  const company = await db.company.create({
    data: {
      name,
      publicId: generatePublicId(),
      incorporationType: "llc",
      incorporationDate: new Date("2026-01-01"),
      incorporationCountry: "US",
      incorporationState: "WY",
      streetAddress: "1 Seed St",
      city: "Cheyenne",
      state: "WY",
      zipcode: "82001",
      country: "US",
      entityType: "LLC",
      timezone: TIME_ZONE,
    },
  });
  const companyRef = {
    id: company.id,
    name: company.name,
    timezone: company.timezone,
  };
  const preferred = await db.unitClass.create({
    data: {
      companyId: company.id,
      name: "Preferred Units",
      kind: "PREFERRED",
      pricePerUnitCents: 100_000n,
      fractionalUnitsAllowed: true,
      votesPerUnit: 1,
      prefReturnBps: 800,
      residualSplitBps: 7000,
      // $40,000 instead of the Agreement's $50,000, so reidTrust's 49.5
      // units of the G1 register can be subscribed (seed data only).
      minCommitmentCents: 4_000_000n,
      minCommitmentFloorCents: 4_000_000n,
      offeringCapCents: 500_000_000n,
      initialInstallmentBps: 4000,
      finalClosingDate: new Date("2026-11-30"),
      balanceOutsideDate: new Date("2027-03-31"),
    },
  });
  await db.unitClass.create({
    data: {
      companyId: company.id,
      name: "Common Units",
      kind: "COMMON",
      authorizedUnits: 1000,
      fractionalUnitsAllowed: false,
      residualSplitBps: 3000,
    },
  });
  const bank = await db.bankAccount.create({
    data: {
      companyId: company.id,
      beneficiaryName: name,
      beneficiaryAddress: "1 Seed St, Cheyenne WY",
      bankName: "Seed Bank",
      bankAddress: "2 Bank St",
      accountNumber: "000123456789",
      routingNumber: "021000021",
      primary: true,
    },
  });

  const user = await waitForUser(opts.managerEmail ?? "ceo@example.com");
  const member =
    (await db.member.findFirst({
      where: { companyId: company.id, userId: user.id },
    })) ??
    (await db.member.create({
      data: {
        companyId: company.id,
        userId: user.id,
        status: "ACTIVE",
        isOnboarded: true,
        role: "ADMIN",
        title: "Manager",
      },
    }));
  const actor: LedgerActor = {
    userId: user.id,
    memberId: member.id,
    name: user.name ?? "Manager",
    requestIp: "seed",
    userAgent: "seed:llc-governance",
  };

  // --- Register (economics "today" pinned in October 2026) ---------------
  const ids = new Map<string, string>();
  const tag = randomUUID().slice(0, 6);
  const samCommitment = { id: "" };
  setEconomicsToday(RECEIVED_ON);
  try {
    for (const h of [
      ...REG,
      {
        key: "octagon",
        name: "Octagon Compute LLC",
        units: 0,
        isInsider: true,
      },
    ]) {
      const s = await db.stakeholder.create({
        data: {
          companyId: company.id,
          name: h.name,
          email: `${h.key.toLowerCase()}.${tag}@example.com`,
          isInsider: h.isInsider ?? false,
        },
      });
      ids.set(h.key, s.id);
    }

    for (const h of REG) {
      const stakeholderId = ids.get(h.key) as string;
      // sam commits 500 units' worth, pays the 40% Initial Installment
      // (200 units) and defaults on the Balance.
      const committed = h.defaulting ? usd(500_000) : usd(h.units * 1000);
      const paid = usd(h.units * 1000);
      const commitmentId = await db.$transaction(async (tx) => {
        const c = await createCommitment(
          tx,
          {
            companyId: company.id,
            stakeholderId,
            unitClassId: preferred.id,
            committedCents: committed,
            signedOn: SIGNED_ON,
          },
          actor,
        );
        await recordCapitalReceipt(
          tx,
          {
            companyId: company.id,
            commitmentId: c.id,
            receivedOn: RECEIVED_ON,
            amountCents: paid,
          },
          actor,
        );
        await decideCommitment(
          tx,
          {
            companyId: company.id,
            commitmentId: c.id,
            decision: "ACCEPT",
            acceptedOn: RECEIVED_ON,
          },
          actor,
        );
        return c.id;
      }, TX);
      if (h.defaulting) samCommitment.id = commitmentId;
      if (h.financialInterestOnly) {
        await db.stakeholder.update({
          where: { id: stakeholderId },
          data: { memberStatus: "FINANCIAL_INTEREST_ONLY" },
        });
      }
    }
    await db.$transaction(
      (tx) =>
        issueCommonUnits(
          tx,
          {
            companyId: company.id,
            stakeholderId: ids.get("octagon") as string,
            units: "100",
            issuedOn: RECEIVED_ON,
          },
          actor,
        ),
      TX,
    );

    // sam: a Call Notice for the Balance, unpaid, default declared.
    try {
      setEconomicsToday(CALL_SENT_ON);
      const { config } = await getEconomicsContext(db, companyRef);
      const dueOn = callNoticeDueDate(CALL_SENT_ON, config);
      const draft = await db.$transaction(
        (tx) =>
          saveCallNoticeDraft(tx, {
            companyId: company.id,
            actor,
            purpose: "Balance of the Capital Contribution (seed)",
            bankAccountId: bank.id,
            lines: [
              {
                commitmentId: samCommitment.id,
                amountCalledCents: usd(300_000),
              },
            ],
          }),
        TX,
      );
      await sendCallNotice(db, {
        company: companyRef,
        actor,
        manager: { name: actor.name, email: user.email ?? "ceo@example.com" },
        id: draft.id,
        expectedDueOn: dueOn,
      });
      const line = await db.callNoticeLine.findFirstOrThrow({
        where: { companyId: company.id, callNoticeId: draft.id },
      });
      setEconomicsToday(addDays(dueOn, 2));
      await db.$transaction(
        (tx) =>
          declareDefault(tx, {
            company: companyRef,
            actor,
            callNoticeLineId: line.id,
            expectedUnpaidCents: usd(300_000),
          }),
        TX,
      );
    } catch (error) {
      console.log(
        `⚠️  sam's default was not seeded (${(error as Error).message}); sam stays unsuspended.`
          .yellow,
      );
    }
  } finally {
    setEconomicsToday(null);
  }

  // --- Resolutions (real date) -------------------------------------------
  const session = {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      companyId: company.id,
      memberId: member.id,
      companyPublicId: company.publicId,
      isOnboarded: true,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;
  const context = {
    db,
    session,
    requestIp: "127.0.0.1",
    userAgent: "seed:llc-governance",
    headers: new Headers(),
  };
  const resolutions = createCallerFactory(resolutionRouter)(context);
  const ballots = createCallerFactory(ballotRouter)({
    ...context,
    session: null,
  });
  const recordDate = todayInZone(new Date(), TIME_ZONE);
  // The ballot-invite and finalize jobs are queued for the app's workers.
  await queue.start();
  try {
    await resolutions.create({
      type: "GENERAL_CONSENT",
      params: { matterKey: "CHANGE_BUSINESS", requireManagerApproval: false },
    });

    const related = await resolutions.create({
      type: "RELATED_PARTY",
      params: {
        counterparty: "Octagon Compute LLC",
        relationship: "Affiliate of the Manager",
        description: "Colocation services for the GPU servers (seed data).",
        amount: "12000.00",
      },
    });
    await resolutions.send({
      publicId: related.publicId,
      recordDate,
      autoReminders: false,
    });
    const sent = await db.resolution.findFirstOrThrow({
      where: { publicId: related.publicId, companyId: company.id },
      select: { id: true, frozenHash: true },
    });
    const aliceBallot = await db.resolutionBallot.findFirstOrThrow({
      where: {
        resolutionId: sent.id,
        companyId: company.id,
        stakeholderId: ids.get("alice") as string,
      },
    });
    await ballots.submit({
      token: await signBallotToken(aliceBallot),
      choice: "FOR",
      signedName: "Alice Anders",
      bodyHash: sent.frozenHash ?? "",
      assent: true,
    });

    const po = await resolutions.create({
      type: "PURCHASE_ORDER",
      params: {
        vendor: "Example GPU Supply Inc.",
        equipment: "8 x GPU servers (seed data)",
        price: "250000.00",
        currency: "USD",
        poReference: "PO-SEED-1",
        managerName: actor.name,
        purchasingAgentName: actor.name,
      },
    });
    await resolutions.send({
      publicId: po.publicId,
      recordDate,
      autoReminders: false,
      managerSignature: { signerName: actor.name, signerCapacity: "Manager" },
    });
  } finally {
    await queue.stop({ graceful: true });
  }

  console.log(
    `🎉 Seeded ${name} (/${company.publicId}): 9 holders, 3 resolutions`.green,
  );
  return { companyId: company.id, publicId: company.publicId };
}
