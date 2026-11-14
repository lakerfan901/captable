/**
 * Proves the daily compliance sweep (src/jobs/governance-daily-sweep.ts)
 * sends ONE digest per Manager user per company per day even when two runs
 * overlap. Not part of `vitest run` (it needs Postgres). Run from the
 * repository root against the LOCAL database only:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=manager@example.com \
 *   NEXTAUTH_SECRET=test-secret \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/jobs/__integration__/daily-sweep-race.integration.ts
 *
 * One throwaway LLC company (`zz-sweep-race-…`) with two Manager users and an
 * OPEN deadline due in 5 days. `send` is replaced by a slow stub (no mail
 * leaves), and both runs are restricted to that company (`companyIds`), so no
 * other company's deadlines are touched. Everything created is deleted.
 */
import { addDays, todayInZone, ymdToUtcDate } from "@/lib/governance/dates";
import type { sendMail } from "@/server/mailer";
import {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  runScenarios,
  section,
  setCompanyPrefix,
} from "../../server/llc/__integration__/harness";
import { runDailySweep } from "../governance-daily-sweep";

setCompanyPrefix("zz-sweep-race-");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overlappingRuns(): Promise<void> {
  section("two overlapping runs send one digest per Manager user");
  const c = await createCompany("race");
  await createAdmin(c);
  await createAdmin(c);
  const now = new Date();
  const dueOn = addDays(todayInZone(now, c.timezone), 5);
  await db.complianceDeadline.create({
    data: {
      companyId: c.id,
      ruleKey: "CUSTOM",
      dedupeKey: `CUSTOM:race-${c.id}`,
      title: "Race deadline",
      dueOn: ymdToUtcDate(dueOn),
      source: "MANUAL",
    },
  });

  const sent: string[] = [];
  // Slow enough that the second run starts while the first is still sending.
  const send = (async (options) => {
    await sleep(400);
    sent.push(String(options.to));
    return { emailLogId: null, sentAt: new Date(), messageId: null };
  }) as typeof sendMail;

  const [a, b] = await Promise.all([
    runDailySweep(now, { send, companyIds: [c.id] }),
    // Started a moment later, while run A holds the company.
    sleep(50).then(() => runDailySweep(now, { send, companyIds: [c.id] })),
  ]);
  const deliveries = [a[0]?.delivery, b[0]?.delivery].sort();
  console.log(
    `  deliveries: ${JSON.stringify(deliveries)}; sends: ${sent.length}`,
  );
  eq("digests sent (2 Manager users, once each)", sent.length, 2);
  eq("distinct recipients", new Set(sent).size, 2);
  check(
    "one run sent, the other stood aside",
    JSON.stringify(deliveries) === JSON.stringify(["CONCURRENT_RUN", "SENT"]),
    JSON.stringify(deliveries),
  );

  section("a later run the same day sends nothing");
  const later = await runDailySweep(now, { send, companyIds: [c.id] });
  eq("later run delivery", later[0]?.delivery, "NOTHING_DUE");
  eq("sends after the later run", sent.length, 2);

  section("two runs started at the same instant");
  // A second deadline due in 5 days gives a fresh reminder.
  await db.complianceDeadline.create({
    data: {
      companyId: c.id,
      ruleKey: "CUSTOM",
      dedupeKey: `CUSTOM:race2-${c.id}`,
      title: "Race deadline 2",
      dueOn: ymdToUtcDate(dueOn),
      source: "MANUAL",
    },
  });
  const before = sent.length;
  const runs = await Promise.all(
    [0, 1, 2].map(() => runDailySweep(now, { send, companyIds: [c.id] })),
  );
  eq("three simultaneous runs: digests sent", sent.length - before, 2);
  eq(
    "three simultaneous runs: runs that sent",
    runs.filter((r) => r[0]?.delivery === "SENT").length,
    1,
  );
}

await runScenarios([["overlapping runs", overlappingRuns]]);
