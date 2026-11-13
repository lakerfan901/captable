/**
 * Shared helpers for the economics integration scripts
 * (defaults.integration.ts, distributions.integration.ts). Not part of
 * `vitest run`: they need the local Postgres. See either script for the
 * command line.
 *
 * Safety: `assertLocalEnvironment` refuses to run against anything but the
 * local docker database and the local mail catcher. Every company created
 * here is named `zz-harden-…`, every address is `@example.com`, and
 * `cleanup` deletes every row of every table that has a `companyId` column
 * for those companies (and sweeps companies left by a crashed run first).
 */
import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { isMailCatcherUrl } from "@/lib/mail-catcher";
import { db, type PrismaTransactionalClient } from "@/server/db";
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
import {
  confirmCredit,
  confirmForfeiture,
  declareDefault,
  recordDefaultFunding,
} from "@/server/llc/economics/defaults";

export type Tx = PrismaTransactionalClient;

export const LOCAL_DATABASE_URL =
  "postgres://captable:password@localhost:54321/captable";
export const MAIL_CATCHER_URL = "smtp://localhost:1025";
export const COMPANY_PREFIX = "zz-harden-";

export const actor: LedgerActor = {
  userId: "harden-integration",
  memberId: null,
  name: "Integration",
  requestIp: "127.0.0.1",
  userAgent: "harden-integration",
};

/** Interactive transaction options for every economics call here. */
export const TX = { timeout: 30_000, maxWait: 10_000 } as const;

export function assertLocalEnvironment(): void {
  if (process.env.DATABASE_URL !== LOCAL_DATABASE_URL) {
    throw new Error(
      `Refusing to run: DATABASE_URL must be exactly ${LOCAL_DATABASE_URL}.`,
    );
  }
  if (
    process.env.EMAIL_SERVER !== MAIL_CATCHER_URL ||
    !isMailCatcherUrl(process.env.EMAIL_SERVER)
  ) {
    throw new Error(
      `Refusing to run: EMAIL_SERVER must be exactly ${MAIL_CATCHER_URL} (mail catcher).`,
    );
  }
  if (!process.env.EMAIL_FROM?.endsWith("@example.com")) {
    throw new Error(
      "Refusing to run: EMAIL_FROM must be an @example.com address.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run with NODE_ENV=production.");
  }
}

// ---------------------------------------------------------------------------
// Checks

const failures: string[] = [];
let checks = 0;

export function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` (${detail})` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

/** `check(label, actual === expected)` with both values in the failure detail. */
export function eq(label: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === "bigint" ? `${actual}n` : JSON.stringify(actual);
  const e =
    typeof expected === "bigint" ? `${expected}n` : JSON.stringify(expected);
  check(label, actual === expected, `got ${a}, expected ${e}`);
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

/** Runs `fn`; returns the error (message and tRPC code), or null when it succeeded. */
export async function errorOf(
  fn: () => Promise<unknown>,
): Promise<{ message: string; code: string | null } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    return { message, code };
  }
}

export async function expectRefused(
  label: string,
  fn: () => Promise<unknown>,
  pattern: RegExp,
  code?: string,
): Promise<void> {
  const error = await errorOf(fn);
  check(
    label,
    error !== null &&
      pattern.test(error.message) &&
      (code === undefined || error.code === code),
    error ? `${error.code ?? ""}: ${error.message}` : "it succeeded",
  );
}

export function summary(): number {
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log(failures.map((f) => `- ${f}`).join("\n"));
  }
  return failures.length;
}

// ---------------------------------------------------------------------------
// Clock, transactions, races

/** Pins "today" for every economics and FOUNDATION service (economicsToday). */
export function setToday(day: string): void {
  process.env.LLC_ECONOMICS_TODAY = day;
}

export function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, TX);
}

/**
 * Runs `first` in a transaction and keeps that transaction open (uncommitted)
 * until `second` has been started and has had `waitMs` to run, so a missing
 * lock shows up as `second` finishing while `first` is still open. Returns
 * both outcomes, whether `second` was still pending when `first` was
 * released, and both backend pids (they must differ).
 */
export async function race<A, B>(
  first: (tx: Tx) => Promise<A>,
  second: (tx: Tx) => Promise<B>,
  waitMs = 600,
): Promise<{
  first:
    | { ok: true; value: A }
    | { ok: false; message: string; code: string | null };
  second:
    | { ok: true; value: B }
    | { ok: false; message: string; code: string | null };
  secondWaited: boolean;
  pids: [number, number];
}> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const firstDone = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let firstFailedEarly: unknown = null;
  const pids: [number, number] = [0, 0];
  const pid = async (tx: Tx) => {
    const rows = await tx.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    return Number(rows[0]?.pid ?? 0);
  };
  const t1 = db
    .$transaction(async (tx) => {
      pids[0] = await pid(tx);
      try {
        const value = await first(tx);
        ready();
        await gate;
        return value;
      } catch (error) {
        firstFailedEarly = error;
        ready();
        throw error;
      }
    }, TX)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => outcomeError(error),
    );
  await firstDone;
  let secondSettled = false;
  const t2 = db
    .$transaction(async (tx) => {
      pids[1] = await pid(tx);
      return second(tx);
    }, TX)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => outcomeError(error),
    )
    .finally(() => {
      secondSettled = true;
    });
  await new Promise((r) => setTimeout(r, waitMs));
  const secondWaited = !secondSettled && firstFailedEarly === null;
  release();
  const [a, b] = await Promise.all([t1, t2]);
  return { first: a, second: b, secondWaited, pids };
}

function outcomeError(error: unknown) {
  return {
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
    code:
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Fixtures

export interface TestCompany {
  id: string;
  name: string;
  timezone: string;
  preferredId: string;
  commonId: string;
  bankAccountId: string;
}

const createdCompanyIds: string[] = [];

export async function createCompany(
  label: string,
  opts: { balanceOutsideDate?: string } = {},
): Promise<TestCompany> {
  const name = `${COMPANY_PREFIX}${label}-${randomUUID().slice(0, 8)}`;
  const company = await db.company.create({
    data: {
      name,
      publicId: name,
      incorporationType: "llc",
      incorporationDate: new Date("2026-01-01"),
      incorporationCountry: "US",
      incorporationState: "WY",
      streetAddress: "1 Test St",
      city: "Cheyenne",
      state: "WY",
      zipcode: "82001",
      country: "US",
      entityType: "LLC",
      timezone: "America/Denver",
    },
  });
  createdCompanyIds.push(company.id);
  const pref = await db.unitClass.create({
    data: {
      companyId: company.id,
      name: "Preferred Units",
      kind: "PREFERRED",
      pricePerUnitCents: 100_000n,
      fractionalUnitsAllowed: true,
      votesPerUnit: 1,
      prefReturnBps: 800,
      residualSplitBps: 7000,
      minCommitmentCents: 5_000_000n,
      minCommitmentFloorCents: 5_000_000n,
      offeringCapCents: 500_000_000n,
      initialInstallmentBps: 4000,
      finalClosingDate: new Date("2026-11-30"),
      balanceOutsideDate: new Date(opts.balanceOutsideDate ?? "2027-03-31"),
    },
  });
  const common = await db.unitClass.create({
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
      beneficiaryAddress: "1 Test St, Cheyenne WY",
      bankName: "Test Bank",
      bankAddress: "2 Bank St",
      accountNumber: "000123456789",
      routingNumber: "021000021",
      primary: true,
    },
  });
  return {
    id: company.id,
    name,
    timezone: company.timezone,
    preferredId: pref.id,
    commonId: common.id,
    bankAccountId: bank.id,
  };
}

export function newMember(
  c: TestCompany,
  name: string,
  extra: { isInsider?: boolean } = {},
) {
  return db.stakeholder.create({
    data: {
      companyId: c.id,
      name,
      email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      isInsider: extra.isInsider ?? false,
    },
  });
}

/**
 * A subscription as FOUNDATION records it: commitment signed before the
 * money, the Initial Installment received (held), then accepted. `today` is
 * set to `acceptedOn` while doing it.
 */
export function subscribe(
  c: TestCompany,
  stakeholderId: string,
  committedCents: bigint,
  initial: { cents: bigint; receivedOn: string; acceptedOn?: string },
): Promise<string> {
  const acceptedOn = initial.acceptedOn ?? initial.receivedOn;
  setToday(acceptedOn);
  return inTx(async (tx) => {
    const commitment = await createCommitment(
      tx,
      {
        companyId: c.id,
        stakeholderId,
        unitClassId: c.preferredId,
        committedCents,
        signedOn: "2026-11-10",
      },
      actor,
    );
    await recordCapitalReceipt(
      tx,
      {
        companyId: c.id,
        commitmentId: commitment.id,
        receivedOn: initial.receivedOn,
        amountCents: initial.cents,
      },
      actor,
    );
    await decideCommitment(
      tx,
      {
        companyId: c.id,
        commitmentId: commitment.id,
        decision: "ACCEPT",
        acceptedOn,
      },
      actor,
    );
    return commitment.id;
  });
}

export async function issueCommon(
  c: TestCompany,
  stakeholderId: string,
  units: string,
  issuedOn: string,
): Promise<void> {
  setToday(issuedOn);
  await inTx((tx) =>
    issueCommonUnits(
      tx,
      { companyId: c.id, stakeholderId, units, issuedOn },
      actor,
    ),
  );
}

const createdUserIds: string[] = [];

/** A team user who is ADMIN of the company, for router callers. */
export async function createAdmin(c: TestCompany) {
  const user = await db.user.create({
    data: {
      name: "Integration",
      email: `harden.${randomUUID().slice(0, 8)}@example.com`,
    },
  });
  createdUserIds.push(user.id);
  const member = await db.member.create({
    data: {
      companyId: c.id,
      userId: user.id,
      status: "ACTIVE",
      isOnboarded: true,
      role: "ADMIN",
    },
  });
  const session = {
    user: {
      id: user.id,
      name: "Integration",
      email: user.email,
      companyId: c.id,
      memberId: member.id,
      companyPublicId: c.name,
      isOnboarded: true,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;
  return {
    session,
    context: {
      db,
      session,
      requestIp: "127.0.0.1",
      userAgent: "harden-integration",
      headers: new Headers(),
    },
  };
}

export const companyRef = (c: TestCompany) => ({
  id: c.id,
  name: c.name,
  timezone: c.timezone,
});

/** Saves a one-line Call Notice draft on `sentOn` and really sends it (mail catcher). */
export async function sendCall(
  c: TestCompany,
  commitmentId: string,
  amountCents: bigint,
  sentOn: string,
  dueOn: string,
) {
  setToday(sentOn);
  const draft = await inTx((tx) =>
    saveCallNoticeDraft(tx, {
      companyId: c.id,
      actor,
      purpose: "Integration test call",
      bankAccountId: c.bankAccountId,
      lines: [{ commitmentId, amountCalledCents: amountCents }],
    }),
  );
  const sent = await sendCallNotice(db, {
    company: companyRef(c),
    actor,
    manager: { name: "Manager", email: "manager@example.com" },
    id: draft.id,
    expectedDueOn: dueOn,
  });
  const line = await db.callNoticeLine.findFirstOrThrow({
    where: { companyId: c.id, callNoticeId: draft.id, commitmentId },
  });
  return { noticeId: draft.id, sent, lineId: line.id, line };
}

/** Dollars → bigint cents (test literals only). */
export const usd = (dollars: number) => BigInt(Math.round(dollars * 100));

/**
 * The E11 worked case (02-economics.md E11) through the real services, without
 * checks (defaults.integration.ts checks every step): Scenario S holders A, B,
 * C plus insider K; C's $60,000 call (sent 2027-01-14, due 2027-01-20) is
 * never paid; A funds $30,000 on 2027-01-25, K $15,000 on 2027-02-01; the
 * forfeiture is confirmed on 2027-01-28 and, unless `stopBeforeCredit`, the
 * credit on 2027-02-19.
 */
export async function buildWorkedCase(
  c: TestCompany,
  opts: { stopBeforeCredit?: boolean } = {},
) {
  const A = await newMember(c, "A Holder");
  const K = await newMember(c, "K Insider", { isInsider: true });
  const B = await newMember(c, "B Holder");
  const C = await newMember(c, "C Defaulter");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  await subscribe(c, K.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-20",
  });
  await subscribe(c, B.id, usd(250_000), {
    cents: usd(250_000),
    receivedOn: "2026-11-23",
  });
  const cCommitment = await subscribe(c, C.id, usd(100_000), {
    cents: usd(40_000),
    receivedOn: "2026-11-30",
  });
  const call = await sendCall(
    c,
    cCommitment,
    usd(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  const input = { company: companyRef(c), actor };
  setToday("2027-01-21");
  const d = await inTx((tx) =>
    declareDefault(tx, {
      ...input,
      callNoticeLineId: call.lineId,
      expectedUnpaidCents: usd(60_000),
    }),
  );
  setToday("2027-01-25");
  await inTx((tx) =>
    recordDefaultFunding(tx, {
      ...input,
      id: d.id,
      funderStakeholderId: A.id,
      amountCents: usd(30_000),
      fundedOn: "2027-01-25",
    }),
  );
  setToday("2027-01-28");
  await inTx((tx) =>
    confirmForfeiture(tx, {
      ...input,
      id: d.id,
      expectedForfeitedCents: usd(30_000),
      expectedUnitsAfter: 10_000_000n,
    }),
  );
  setToday("2027-02-01");
  await inTx((tx) =>
    recordDefaultFunding(tx, {
      ...input,
      id: d.id,
      funderStakeholderId: K.id,
      amountCents: usd(15_000),
      fundedOn: "2027-02-01",
    }),
  );
  if (!opts.stopBeforeCredit) {
    setToday("2027-02-19");
    await inTx((tx) =>
      confirmCredit(tx, {
        ...input,
        id: d.id,
        expectedPoolACents: usd(11_250),
        expectedPoolBCents: usd(22_500),
      }),
    );
  }
  return { A, B, K, C, cCommitment, lineId: call.lineId, defaultId: d.id };
}

// ---------------------------------------------------------------------------
// Cleanup

async function companyTables(): Promise<string[]> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'companyId'
    ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

async function deleteCompanies(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const tables = await companyTables();
  for (const table of tables) {
    await db.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE "companyId" = ANY($1::text[])`,
      ids,
    );
  }
  await db.$executeRaw`DELETE FROM "Company" WHERE id = ANY(${ids}::text[])`;
  let left = 0;
  for (const table of tables) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${table}" WHERE "companyId" = ANY($1::text[])`,
      ids,
    );
    left += Number(rows[0]?.n ?? 0n);
  }
  const companies = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "Company" WHERE id = ANY(${ids}::text[])`;
  return left + Number(companies[0]?.n ?? 0n);
}

/** Companies left behind by an earlier crashed run of these scripts. */
export async function sweepLeftovers(): Promise<void> {
  // Only companies older than an hour: a concurrent run of these scripts
  // (another session) keeps its own companies.
  const rows = await db.company.findMany({
    where: {
      name: { startsWith: COMPANY_PREFIX },
      createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
    },
    select: { id: true },
  });
  const left = await deleteCompanies(rows.map((r) => r.id));
  if (rows.length > 0) {
    console.log(
      `swept ${rows.length} leftover ${COMPANY_PREFIX} compan${rows.length === 1 ? "y" : "ies"} (${left} rows left)`,
    );
  }
}

export async function cleanup(): Promise<number> {
  const left = await deleteCompanies(createdCompanyIds);
  if (createdUserIds.length > 0) {
    await db.$executeRaw`DELETE FROM "User" WHERE id = ANY(${createdUserIds}::text[])`;
  }
  const users = await db.user.count({ where: { id: { in: createdUserIds } } });
  const stray = await db.company.count({
    where: { name: { startsWith: COMPANY_PREFIX } },
  });
  console.log(
    `cleanup: ${left} rows and ${users} users left for this run's ${createdCompanyIds.length} test companies; ${stray} ${COMPANY_PREFIX} companies in the database (other runs included)`,
  );
  return left + users;
}

/** Runs the scenarios, cleans up, prints the summary and sets the exit code. */
export async function runScenarios(
  scenarios: [string, () => Promise<void>][],
): Promise<void> {
  assertLocalEnvironment();
  let left = 0;
  try {
    await sweepLeftovers();
    for (const [name, run] of scenarios) {
      const error = await errorOf(run);
      if (error !== null) {
        check(`${name} ran to the end`, false, error.message);
      }
    }
  } finally {
    left = await cleanup();
    await db.$disconnect();
  }
  check("database clean after the run", left === 0, `${left} rows left`);
  const failed = summary();
  if (failed > 0) process.exit(1);
}

export { db };
