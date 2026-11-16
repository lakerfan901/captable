/**
 * Which From address the portal invitation and the report email go out
 * under when both EMAIL_FROM and EMAIL_FROM_TRANSACTIONAL are set
 * (src/lib/mail-sender.ts; package P11, item 4g). Not part of `vitest run`.
 * Run from the repository root with the standard integration command:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-mail-from.integration.ts
 *
 * The script sets its own two sender addresses before any server module is
 * loaded (every import below is dynamic, because `@/env` reads
 * `process.env` once, when it is first imported). Mail goes to the local
 * catcher only (Mailpit, SMTP on 1025, API on 8025): the script refuses any
 * other EMAIL_SERVER. Each email is delivered by its real worker through the
 * real `sendMail`, and the From header is read back from what Mailpit
 * received, and from the EmailLog row.
 *
 * Companies are named `zz-portal-mail-from-…`, addresses `@example.com`.
 * Every row created and every caught message is deleted at the end.
 */
import { randomUUID } from "node:crypto";

const INVESTOR_FROM = "zz-p11-investor-relations@example.com";
const TRANSACTIONAL_FROM = "zz-p11-accounts@example.com";
process.env.EMAIL_FROM = INVESTOR_FROM;
process.env.EMAIL_FROM_TRANSACTIONAL = TRANSACTIONAL_FROM;
const EMAIL_PREFIX = "zz-portal-mail-from.";
const MAILPIT = "http://localhost:8025";

if (
  !/^smtp:\/\/(localhost|127\.0\.0\.1):1025\/?$/.test(
    process.env.EMAIL_SERVER ?? "",
  )
) {
  console.error(
    "Refusing to run: EMAIL_SERVER must be the local catcher (smtp://localhost:1025).",
  );
  process.exit(1);
}

const harness = await import("@/server/llc/__integration__/harness");
const {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  newMember,
  runScenarios,
  section,
  setCompanyPrefix,
  setToday,
  subscribe,
  usd,
} = harness;
const { todayInZone } = await import("@/lib/governance/dates");
const { createCallerFactory } = await import("@/trpc/api/trpc");
const { portalAdminRouter } = await import(
  "@/trpc/routers/portal-admin-router/router"
);
const { memberReportRouter } = await import(
  "@/trpc/routers/member-report-router/router"
);
const { portalAccountEmailJob } = await import("@/server/portal/account-email");
const { deliverPortalAccountEmail } = await import(
  "@/jobs/portal-account-email"
);
const { reportEmailJob, reportEmailWorker } = await import(
  "@/jobs/governance-report-email"
);
const { reportFileJob } = await import("@/jobs/governance-report-file");

setCompanyPrefix("zz-portal-mail-from-");

// pg-boss is not started: queued jobs are captured and run here by hand.
const accountJobs: unknown[] = [];
(portalAccountEmailJob as { emit: unknown }).emit = (data: unknown) => {
  accountJobs.push(data);
  return Promise.resolve(null);
};
const reportJobs: { data: unknown }[] = [];
(reportEmailJob as { bulkEmit: unknown }).bulkEmit = (
  items: { data: unknown }[],
) => {
  reportJobs.push(...items);
  return Promise.resolve(null);
};
(reportFileJob as { emit: unknown }).emit = () => Promise.resolve();

const portalUserIds: string[] = [];

interface CaughtMessage {
  ID: string;
  From?: { Address: string; Name: string };
  To?: { Address: string }[];
  Subject?: string;
}

async function caughtTo(address: string): Promise<CaughtMessage[]> {
  const res = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=20`,
  );
  const body = (await res.json()) as { messages?: CaughtMessage[] };
  return (body.messages ?? []).filter((m) =>
    m.To?.some((t) => t.Address.toLowerCase() === address.toLowerCase()),
  );
}

async function deleteCaughtMail(): Promise<void> {
  try {
    const res = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${EMAIL_PREFIX}`)}&limit=200`,
    );
    const body = (await res.json()) as { messages?: CaughtMessage[] };
    const ids = (body.messages ?? [])
      .filter((m) => m.To?.some((t) => t.Address.startsWith(EMAIL_PREFIX)))
      .map((m) => m.ID);
    if (ids.length === 0) return;
    await fetch(`${MAILPIT}/api/v1/messages`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ IDs: ids }),
    });
  } catch {
    // the catcher is not needed to clean the database
  }
}

function paragraph(t: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: t, styles: {} }],
    children: [],
  };
}

async function scenario() {
  section(
    "setup: one LLC, one Preferred Member with an @example.com notice address",
  );
  const c = await createCompany("one");
  const holder = await newMember(c, "Mail From Holder");
  const notice = `${EMAIL_PREFIX}notice.${randomUUID().slice(0, 8)}@example.com`;
  await db.stakeholder.update({
    where: { id: holder.id },
    data: { noticeEmail: notice },
  });
  await subscribe(c, holder.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  setToday(todayInZone(new Date(), c.timezone));
  const admin = await createAdmin(c);
  const portalAdmin = createCallerFactory(portalAdminRouter)(admin.context);
  const reports = createCallerFactory(memberReportRouter)(admin.context);

  section("1. portal invitation: the transactional sender");
  const inviteTo = `${EMAIL_PREFIX}invitee.${randomUUID().slice(0, 8)}@example.com`;
  await portalAdmin.invite({ stakeholderId: holder.id, email: inviteTo });
  const user = await db.portalUser.findUniqueOrThrow({
    where: { email: inviteTo },
  });
  portalUserIds.push(user.id);
  eq("one account email queued", accountJobs.length, 1);
  const outcome = await deliverPortalAccountEmail(
    accountJobs[0] as Parameters<typeof deliverPortalAccountEmail>[0],
  );
  eq("the invitation worker sends", outcome, "SENT");
  const [invite] = await caughtTo(inviteTo);
  check("the catcher received the invitation", invite !== undefined);
  eq(
    "invitation From is EMAIL_FROM_TRANSACTIONAL",
    invite?.From?.Address,
    TRANSACTIONAL_FROM,
  );
  const inviteLog = await db.emailLog.findFirst({
    where: { toAddress: inviteTo, kind: "portal.invite" },
    select: { fromAddress: true, status: true },
  });
  eq(
    "its EmailLog row records the transactional sender",
    inviteLog?.fromAddress,
    TRANSACTIONAL_FROM,
  );
  eq("its EmailLog row is SENT", inviteLog?.status, "SENT");

  section("2. report email (release with email ticked): the investor sender");
  const { publicId } = await reports.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await reports.update({
    publicId,
    title: "Notice for the sender check",
    figures: {},
    commentary: [paragraph("A notice to check the sender address.")],
  });
  await reports.release({ publicId, stakeholderIds: [holder.id], email: true });
  eq("one report email queued", reportJobs.length, 1);
  await reportEmailWorker.handler([
    {
      ...(reportJobs[0] as object),
      id: "p11-mail-from",
      name: "governance.report-email",
    } as never,
  ]);
  const [report] = await caughtTo(notice);
  check("the catcher received the report email", report !== undefined);
  eq(
    "report From is EMAIL_FROM (not the transactional address)",
    report?.From?.Address,
    INVESTOR_FROM,
  );
  eq("report From keeps the company display name", report?.From?.Name, c.name);
  const reportLog = await db.emailLog.findFirst({
    where: { toAddress: notice, companyId: c.id },
    select: { fromAddress: true, kind: true, status: true },
  });
  eq(
    "its EmailLog row records the investor sender",
    reportLog?.fromAddress,
    process.env.EMAIL_FROM,
  );
  eq(
    "its EmailLog kind is the report delivery",
    reportLog?.kind,
    "memberReport.delivery",
  );
  eq("its EmailLog row is SENT", reportLog?.status, "SENT");
}

async function cleanupPortal() {
  section("cleanup: portal users, sessions, tokens, caught mail");
  if (portalUserIds.length > 0) {
    await db.portalAccessLog.deleteMany({
      where: { portalUserId: { in: portalUserIds } },
    });
    await db.portalAccess.deleteMany({
      where: { portalUserId: { in: portalUserIds } },
    });
    await db.portalUser.deleteMany({ where: { id: { in: portalUserIds } } });
  }
  await db.emailLog.deleteMany({
    where: { toAddress: { startsWith: EMAIL_PREFIX } },
  });
  await deleteCaughtMail();
  const left =
    (await db.portalUser.count({
      where: { email: { startsWith: EMAIL_PREFIX } },
    })) +
    (await db.portalAccountToken.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.emailLog.count({
      where: { toAddress: { startsWith: EMAIL_PREFIX } },
    }));
  eq("no portal row or email log left", left, 0);
  const res = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${EMAIL_PREFIX}`)}&limit=50`,
  );
  const rest =
    ((await res.json()) as { messages?: CaughtMessage[] }).messages ?? [];
  eq(
    "no caught message left",
    rest.filter((m) => m.To?.some((t) => t.Address.startsWith(EMAIL_PREFIX)))
      .length,
    0,
  );
}

await runScenarios([
  ["sender addresses", scenario],
  ["portal cleanup", cleanupPortal],
]);
