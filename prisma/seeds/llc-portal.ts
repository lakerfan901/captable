/**
 * LOCAL DEVELOPMENT ONLY (04-investor-portal.md package P11 "Seed"): an LLC
 * with a year of history published to the investor portal, for demos.
 *
 * Called from `prisma/seeds/index.ts` after the governance seed, only when
 * NODE_ENV is "test" (the `db:seed` script sets it); refuses
 * NODE_ENV=production itself as well. Server modules import `server-only`,
 * so the caller loads `./server-only-hook.mjs` before importing this file.
 * Every address is `@example.com`; no email is sent (every release is
 * portal-only and no job is queued). Files are tiny PDFs uploaded to the
 * configured object store (local MinIO), under the company's key namespace.
 *
 * Company "Octagon Portal Demo LLC" (name configurable):
 *
 * | holder            | class     | contributed | received   |
 * |-------------------|-----------|-------------|------------|
 * | Alice Anders      | Preferred | 100,000     | 2025-10-01 |
 * | Bob Barrett       | Preferred | 150,000     | 2025-10-01 |
 * | Carol Chen        | Preferred | 75,000      | 2025-11-03 |
 * | Octagon Compute   | Common    | 100 units   | 2025-10-01 | insider
 * | Dana Diaz         | prospect  | —           | —          |
 *
 * Twelve months of revenue (October 2025 – September 2026), monthly colocation
 * and power costs, one equipment purchase from capital, a minimum operating
 * reserve, two distributions (January and April 2026). Released, in date
 * order and portal-only: Q4 2025, the 2025 annual report (balance sheet and
 * income statement attached), Q1, Q2 and Q3 2026 (to every current Member),
 * a 2025 TAX_K1 report (K-1 files for Alice and Bob), a notice with a shared
 * letter, and one notice "sent before the portal" (never published). So four
 * quarters are published and the dashboard has shape. Then the books are
 * reopened, a February 2026 expense is back-dated and February onwards are
 * restated (February changes, and the later months through Available Cash;
 * the dashboard shows "Restated" on them), and the books are closed again.
 *
 * Portal (password `PORTAL_DEMO_PASSWORD` below):
 * - `portal.demo@example.com`: password set, access to Alice and Carol (one
 *   person, two holders: the switcher);
 * - `bob.invited@example.com`: invited for Bob, no password yet;
 * - `carol.former@example.com`: a DISABLED access to Carol.
 * Documents: "Operating Agreement summary" shared with Alice and Bob; a W-9
 * tied to Alice, shared with Alice.
 *
 * Portal users are matched by address (`PortalUser.email` is unique across
 * companies), so seeding twice reuses them and resets the demo password.
 */
import colors from "colors";
import type { Session } from "next-auth";
import { generatePublicId } from "@/common/id";
import { fromDateOnly } from "@/lib/date-only";
import { monthsBetween } from "@/lib/llc/financial-periods";
import { queue } from "@/lib/queue";
import { db } from "@/server/db";
import { uploadFile } from "@/server/file-uploads";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
import {
  createCommitment,
  decideCommitment,
  issueCommonUnits,
  type LedgerActor,
  recordCapitalReceipt,
} from "@/server/llc/commitments";
import {
  computeDistribution,
  finalizeDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { createCallerFactory } from "@/trpc/api/trpc";
import { financialDashboardRouter } from "@/trpc/routers/financial-dashboard-router/router";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { portalAdminRouter } from "@/trpc/routers/portal-admin-router/router";

colors.enable();

export const PORTAL_DEMO_PASSWORD = "Portal-Demo-Pass-2026";
export const PORTAL_DEMO_EMAIL = "portal.demo@example.com";

const TX = { timeout: 60_000, maxWait: 10_000 } as const;
const TIME_ZONE = "America/Denver";
const usd = (dollars: number) => BigInt(Math.round(dollars * 100));
const MONTHS = monthsBetween("2025-10-01", "2026-09-01");

function setEconomicsToday(day: string | null) {
  if (day === null) delete process.env.LLC_ECONOMICS_TODAY;
  else process.env.LLC_ECONOMICS_TODAY = day;
}

/** A one-page PDF that pdf.js opens, with one line of text. */
export function tinyPdf(text: string): Uint8Array {
  const safe = text.replace(/[()\\]/g, "");
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function paragraph(text: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

/** The team user the seed acts as (seedTeam's CEO by default). */
async function waitForUser(email: string) {
  for (let i = 0; i < 50; i++) {
    const user = await db.user.findUnique({ where: { email } });
    if (user) return user;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Seed: team user ${email} was not created.`);
}

export interface SeededPortal {
  companyId: string;
  companyPublicId: string;
  bucketIds: string[];
  portalUserIds: string[];
}

export async function seedLlcPortal(
  opts: { name?: string; managerEmail?: string; queueJobs?: boolean } = {},
): Promise<SeededPortal> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The investor portal seed never runs in production.");
  }
  const name = opts.name ?? "Octagon Portal Demo LLC";
  console.log(`Seeding the investor portal demo (${name})`.blue);

  const company = await db.company.create({
    data: {
      name,
      publicId: generatePublicId(),
      incorporationType: "llc",
      incorporationDate: new Date("2025-09-01"),
      incorporationCountry: "US",
      incorporationState: "WY",
      streetAddress: "1 Portal St",
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
      minCommitmentCents: 5_000_000n,
      minCommitmentFloorCents: 5_000_000n,
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
  await db.bankAccount.create({
    data: {
      companyId: company.id,
      beneficiaryName: name,
      beneficiaryAddress: "1 Portal St, Cheyenne WY",
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
    userAgent: "seed:llc-portal",
  };
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
    userAgent: "seed:llc-portal",
    headers: new Headers(),
  };
  const reports = createCallerFactory(memberReportRouter)(context);
  const portalAdmin = createCallerFactory(portalAdminRouter)(context);
  const dashboard = createCallerFactory(financialDashboardRouter)(context);

  const bucketIds: string[] = [];
  async function pdfBucket(fileName: string, title: string) {
    const uploaded = await uploadFile(
      new File([tinyPdf(title) as BlobPart], fileName, {
        type: "application/pdf",
      }),
      { keyPrefix: "generic-documents", identifier: company.publicId },
    );
    const row = await db.bucket.create({
      data: {
        name: uploaded.name,
        key: uploaded.key,
        mimeType: uploaded.mimeType,
        size: uploaded.size,
        tags: ["seed"],
      },
    });
    bucketIds.push(row.id);
    return row;
  }

  // --- Register and ledger (economics "today" pinned) ---------------------
  const holder = async (
    key: string,
    holderName: string,
    extra: { isInsider?: boolean } = {},
  ) =>
    db.stakeholder.create({
      data: {
        companyId: company.id,
        name: holderName,
        email: `${key}.portal-demo@example.com`,
        isInsider: extra.isInsider ?? false,
      },
    });
  const alice = await holder("alice", "Alice Anders");
  const bob = await holder("bob", "Bob Barrett");
  const carol = await holder("carol", "Carol Chen");
  const octagon = await holder("octagon", "Octagon Compute LLC", {
    isInsider: true,
  });
  const dana = await holder("dana", "Dana Diaz");

  async function subscribe(stakeholderId: string, dollars: number, on: string) {
    setEconomicsToday(on);
    await db.$transaction(async (tx) => {
      const c = await createCommitment(
        tx,
        {
          companyId: company.id,
          stakeholderId,
          unitClassId: preferred.id,
          committedCents: usd(dollars),
          signedOn: on,
        },
        actor,
      );
      await recordCapitalReceipt(
        tx,
        {
          companyId: company.id,
          commitmentId: c.id,
          receivedOn: on,
          amountCents: usd(dollars),
        },
        actor,
      );
      await decideCommitment(
        tx,
        {
          companyId: company.id,
          commitmentId: c.id,
          decision: "ACCEPT",
          acceptedOn: on,
        },
        actor,
      );
    }, TX);
  }

  const expense = (
    on: string,
    category: "COLOCATION" | "POWER" | "EQUIPMENT_ACQUISITION" | "INSURANCE",
    cents: bigint,
    fundingSource:
      | "OPERATING_CASH"
      | "CAPITAL_CONTRIBUTIONS" = "OPERATING_CASH",
  ) =>
    db.expenseEntry.create({
      data: {
        companyId: company.id,
        incurredOn: fromDateOnly(on),
        category,
        payee: `${category.toLowerCase().replace("_", " ")} vendor`,
        amountCents: cents,
        fundingSource,
        createdById: member.id,
      },
    });

  async function distribute(
    periodEnd: string,
    paymentDate: string,
    on: string,
  ) {
    setEconomicsToday(on);
    const input = { company: companyRef, actor };
    const draft = await db.$transaction(
      (tx) =>
        saveDistributionDraft(tx, {
          ...input,
          type: "OPERATING",
          periodStart: null,
          periodEnd,
          paymentDate,
          inputs: { type: "OPERATING" },
          notes: "Seed distribution",
        }),
      TX,
    );
    const comp = await db.$transaction(
      (tx) => computeDistribution(tx, companyRef, draft.id),
      TX,
    );
    if (comp.blockers.length > 0 || comp.amount <= 0n) {
      console.log(
        `⚠️  distribution for ${periodEnd} not seeded (${comp.blockers.map((b) => b.code).join(", ") || "nothing to distribute"})`
          .yellow,
      );
      return;
    }
    await db.$transaction(
      (tx) =>
        finalizeDistribution(tx, {
          ...input,
          id: draft.id,
          expectedHash: comp.hash,
          solvencyConfirmed: true,
        }),
      TX,
    );
  }

  try {
    await db.$transaction(
      (tx) =>
        issueCommonUnits(
          tx,
          {
            companyId: company.id,
            stakeholderId: octagon.id,
            units: "100",
            issuedOn: "2025-10-01",
          },
          actor,
        ),
      TX,
    );
    await subscribe(alice.id, 100_000, "2025-10-01");
    await subscribe(bob.id, 150_000, "2025-10-01");
    await subscribe(carol.id, 75_000, "2025-11-03");
    await db.reserveEntry.create({
      data: {
        companyId: company.id,
        effectiveOn: fromDateOnly("2025-10-15"),
        kind: "MINIMUM_OPERATING",
        type: "ESTABLISH",
        amountCents: usd(50_000),
        fundingSource: "CAPITAL_CONTRIBUTIONS",
        reason: "Minimum operating reserve (seed)",
        createdById: member.id,
      },
    });
    await expense(
      "2025-10-20",
      "EQUIPMENT_ACQUISITION",
      usd(120_000),
      "CAPITAL_CONTRIBUTIONS",
    );
    const receipts = [
      14_000, 17_500, 19_000, 21_000, 22_500, 24_000, 23_000, 26_500, 28_000,
      29_500, 31_000, 30_250,
    ];
    for (const [i, month] of MONTHS.entries()) {
      const gross = usd(receipts[i] ?? 25_000);
      const fees = gross / 50n;
      await db.revenuePeriod.create({
        data: {
          companyId: company.id,
          month: fromDateOnly(month),
          customerReceiptsCents: gross,
          passThroughFeesCents: fees,
          otherIncomeCents: usd(120),
          utilizationBps: 7_200 + i * 150,
          managementFeeBps: 500,
          managementFeeCents: ((gross - fees) * 500n + 5_000n) / 10_000n,
          updatedById: member.id,
        },
      });
      await expense(`${month.slice(0, 8)}12`, "COLOCATION", usd(3_200));
      await expense(`${month.slice(0, 8)}18`, "POWER", usd(1_850 + i * 40));
    }
    await expense("2026-03-05", "INSURANCE", usd(2_400));
    await distribute("2025-12-31", "2026-01-20", "2026-01-15");
    await distribute("2026-03-31", "2026-04-20", "2026-04-15");
  } finally {
    setEconomicsToday(null);
  }

  // --- Reports, released in date order (portal only) ----------------------
  // Each release queues the filing job (the report PDF), for the app's
  // workers. `queueJobs: false` (a test run) leaves the queue alone.
  const useQueue = opts.queueJobs !== false;
  if (useQueue) await queue.start();
  try {
    const currentMembers = [alice.id, bob.id, carol.id, octagon.id];
    setEconomicsToday("2026-10-05");
    try {
      async function quarterly(
        fiscalYear: number,
        fiscalQuarter: 1 | 2 | 3 | 4,
      ) {
        const { publicId } = await reports.create({
          type: "QUARTERLY",
          fiscalYear,
          fiscalQuarter,
        });
        const row = await db.memberReport.findFirstOrThrow({
          where: { publicId, companyId: company.id },
        });
        // biome-ignore lint/suspicious/noExplicitAny: seed edits the figures JSON
        const figures = JSON.parse(JSON.stringify(row.figures)) as any;
        figures.utilization.bps ??= 8_000;
        figures.managerPayments.confirmedNone = true;
        await reports.update({
          publicId,
          title: `Q${fiscalQuarter} ${fiscalYear} report to Members`,
          figures,
          commentary: [
            paragraph(
              `Operations in Q${fiscalQuarter} ${fiscalYear}: utilization rose and the colocation contract was renewed.`,
            ),
          ],
        });
        await reports.release({
          publicId,
          stakeholderIds: currentMembers,
          email: false,
        });
        return publicId;
      }

      await quarterly(2025, 4);

      // The 2025 annual report, with its two statements.
      const annual = await reports.create({ type: "ANNUAL", fiscalYear: 2025 });
      const annualRow = await db.memberReport.findFirstOrThrow({
        where: { publicId: annual.publicId, companyId: company.id },
      });
      for (const [kind, label] of [
        ["BALANCE_SHEET", "Balance sheet 2025"],
        ["INCOME_STATEMENT", "Income statement 2025"],
      ] as const) {
        const b = await pdfBucket(`${label}.pdf`, label);
        await db.memberReportAttachment.create({
          data: {
            reportId: annualRow.id,
            companyId: company.id,
            kind,
            name: `${label}.pdf`,
            bucketId: b.id,
          },
        });
      }
      // biome-ignore lint/suspicious/noExplicitAny: seed edits the figures JSON
      const af = JSON.parse(JSON.stringify(annualRow.figures)) as any;
      if (af?.managerPayments) af.managerPayments.confirmedNone = true;
      await reports.update({
        publicId: annual.publicId,
        title: "2025 annual report to Members",
        figures: af,
        commentary: [
          paragraph("The first (short) fiscal year of the Company."),
        ],
      });
      await reports.release({
        publicId: annual.publicId,
        stakeholderIds: currentMembers,
        email: false,
      });

      await quarterly(2026, 1);
      await quarterly(2026, 2);
      await quarterly(2026, 3);
    } finally {
      setEconomicsToday(null);
    }

    // A 2025 TAX_K1 report with K-1 files for Alice and Bob.
    await db.$transaction(
      (tx) => syncComplianceDeadlines(tx, company.id, new Date()),
      TX,
    );
    const k1Target = await db.complianceDeadline.findFirst({
      where: { companyId: company.id, dedupeKey: "K1_TARGET:2025" },
      select: { id: true },
    });
    if (k1Target) {
      const k1 = await reports.create({
        type: "TAX_K1",
        fiscalYear: 2025,
        relatedType: "COMPLIANCE_DEADLINE",
        relatedId: k1Target.id,
      });
      const k1Row = await db.memberReport.findFirstOrThrow({
        where: { publicId: k1.publicId, companyId: company.id },
      });
      for (const h of [alice, bob]) {
        const b = await pdfBucket(
          `Schedule K-1 2025 ${h.name}.pdf`,
          `Schedule K-1 (2025) for ${h.name}`,
        );
        await db.memberReportAttachment.create({
          data: {
            reportId: k1Row.id,
            companyId: company.id,
            kind: "K1",
            name: `Schedule K-1 2025 ${h.name}.pdf`,
            bucketId: b.id,
            stakeholderId: h.id,
          },
        });
      }
      await reports.release({
        publicId: k1.publicId,
        stakeholderIds: [alice.id, bob.id],
        email: false,
      });
    } else {
      console.log(
        "⚠️  no 2025 K-1 deadline: the TAX_K1 report is not seeded".yellow,
      );
    }

    // A notice with a shared letter.
    const notice = await reports.create({
      type: "NOTICE",
      noticeKind: "GENERAL",
    });
    const noticeRow = await db.memberReport.findFirstOrThrow({
      where: { publicId: notice.publicId, companyId: company.id },
    });
    const letter = await pdfBucket(
      "Letter to Members.pdf",
      "Letter to Members",
    );
    await db.memberReportAttachment.create({
      data: {
        reportId: noticeRow.id,
        companyId: company.id,
        kind: "GENERAL",
        name: "Letter to Members.pdf",
        bucketId: letter.id,
      },
    });
    await reports.update({
      publicId: notice.publicId,
      title: "Notice: new colocation site",
      figures: {},
      commentary: [
        paragraph("The servers move to the new colocation site in November."),
      ],
    });
    await reports.release({
      publicId: notice.publicId,
      stakeholderIds: currentMembers,
      email: false,
    });

    // A notice sent before the portal existed (publishedAt never set).
    const legacy = await db.memberReport.create({
      data: {
        publicId: generatePublicId(),
        companyId: company.id,
        type: "NOTICE",
        status: "SENT",
        noticeKind: "GENERAL",
        title: "Welcome letter (sent before the portal)",
        commentary: [],
        figures: {},
        frozenContent: {
          title: "Welcome letter (sent before the portal)",
          doc: [paragraph("Welcome to the Company.")],
        },
        frozenHash: "seed",
        sentAt: new Date("2025-10-02T16:00:00Z"),
        authorId: member.id,
      },
    });
    await db.memberReportRecipient.create({
      data: {
        reportId: legacy.id,
        companyId: company.id,
        stakeholderId: alice.id,
        name: alice.name,
        email: alice.email,
        tokenExpiresAt: new Date(Date.now() + 365 * 86_400_000),
        sentAt: new Date("2025-10-02T16:00:00Z"),
        sendCount: 1,
      },
    });
  } finally {
    // a failed release must not leave pg-boss running (the seed would hang)
    if (useQueue) await queue.stop({ graceful: true });
  }

  // --- One restatement (P35): reopen, back-date, restate, close -------------
  const term = await db.llcTerm.findUnique({
    where: { companyId: company.id },
    select: { booksClosedThrough: true },
  });
  await db.llcTerm.update({
    where: { companyId: company.id },
    data: { booksClosedThrough: null },
  });
  await expense("2026-02-24", "POWER", usd(640));
  try {
    await dashboard.restate({
      fromMonth: "2026-02-01",
      toMonth: "2026-09-01",
      reason: "A February power invoice arrived late (seed data).",
    });
  } catch (error) {
    console.log(
      `⚠️  restatement not seeded (${(error as Error).message})`.yellow,
    );
  }
  await db.llcTerm.update({
    where: { companyId: company.id },
    data: { booksClosedThrough: term?.booksClosedThrough ?? null },
  });

  // --- Documents ------------------------------------------------------------
  const summary = await pdfBucket(
    "Operating Agreement summary.pdf",
    "Operating Agreement summary",
  );
  const summaryDoc = await db.document.create({
    data: {
      companyId: company.id,
      publicId: generatePublicId(),
      name: "Operating Agreement summary.pdf",
      bucketId: summary.id,
      uploaderId: member.id,
    },
  });
  const w9 = await pdfBucket("W-9 Alice Anders.pdf", "Form W-9, Alice Anders");
  const w9Doc = await db.document.create({
    data: {
      companyId: company.id,
      publicId: generatePublicId(),
      name: "W-9 Alice Anders.pdf",
      bucketId: w9.id,
      stakeholderId: alice.id,
      kind: "w9",
      uploaderId: member.id,
    },
  });
  await portalAdmin.shareDocuments({
    documentPublicIds: [summaryDoc.publicId],
    stakeholderIds: [alice.id, bob.id],
  });
  await portalAdmin.shareDocuments({
    documentPublicIds: [w9Doc.publicId],
    stakeholderIds: [alice.id],
  });

  // --- Portal users -----------------------------------------------------------
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PORTAL_DEMO_PASSWORD, 12);
  const portalUserIds: string[] = [];
  async function portalUser(email: string, withPassword: boolean) {
    const row = await db.portalUser.upsert({
      where: { email },
      create: {
        email,
        passwordHash: withPassword ? hash : null,
        passwordSetAt: withPassword ? new Date() : null,
      },
      update: withPassword
        ? {
            passwordHash: hash,
            passwordSetAt: new Date(),
            failedSignIns: 0,
            lockedUntil: null,
          }
        : {},
    });
    portalUserIds.push(row.id);
    return row;
  }
  const accessRow = (
    portalUserId: string,
    stakeholderId: string,
    status: "ACTIVE" | "DISABLED" = "ACTIVE",
  ) =>
    db.portalAccess.create({
      data: {
        publicId: generatePublicId(),
        portalUserId,
        companyId: company.id,
        stakeholderId,
        status,
        invitedById: member.id,
        inviteSentAt: new Date(),
        disabledAt: status === "DISABLED" ? new Date() : null,
        disabledById: status === "DISABLED" ? member.id : null,
      },
    });
  const demo = await portalUser(PORTAL_DEMO_EMAIL, true);
  await accessRow(demo.id, alice.id);
  await accessRow(demo.id, carol.id);
  const invited = await portalUser("bob.invited@example.com", false);
  await accessRow(invited.id, bob.id);
  const former = await portalUser("carol.former@example.com", true);
  await accessRow(former.id, carol.id, "DISABLED");
  void dana;

  console.log(
    `Investor portal demo: sign in at /portal/sign-in as ${PORTAL_DEMO_EMAIL} (password ${PORTAL_DEMO_PASSWORD}).`
      .green,
  );
  return {
    companyId: company.id,
    companyPublicId: company.publicId,
    bucketIds,
    portalUserIds,
  };
}
