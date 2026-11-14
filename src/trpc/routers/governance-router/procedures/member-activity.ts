import { z } from "zod";
import { utcDateToYmd } from "@/lib/governance/dates";
import { frozenTitle } from "@/server/governance/frozen";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";

// governance.memberActivity (03-governance.md G19): one Member's governance
// history for the member detail page: the ballots it was sent, the reports
// and notices sent to it, and the unit transfers it is a party to. Each list
// is scoped by `companyId` AND `stakeholderId`, newest first, at most 100.

const LIMIT = 100;

export const ZMemberActivitySchema = z
  .object({ stakeholderId: z.string().trim().min(1).max(64) })
  .strict();

export interface MemberActivityBallot {
  resolutionPublicId: string;
  referenceCode: string | null;
  title: string;
  type: string;
  status: string;
  preferredUnits: string;
  choice: "FOR" | "AGAINST" | "ABSTAIN" | null;
  deemed: boolean;
  submittedAt: Date | null;
}

export interface MemberActivityReport {
  reportPublicId: string;
  title: string;
  type: string;
  sentAt: Date | null;
  firstViewedAt: Date | null;
}

export interface MemberActivityTransfer {
  transferPublicId: string;
  direction: "IN" | "OUT";
  units: string;
  unitClassKind: string;
  status: string;
  effectiveOn: string | null;
  admittedOn: string | null;
}

export const memberActivityProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberActivitySchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const { stakeholderId } = input;
    await assertCompanyOwns(ctx.db, companyId, {
      stakeholderIds: [stakeholderId],
    });

    const [ballots, reports, transfers] = await Promise.all([
      ctx.db.resolutionBallot.findMany({
        where: { companyId, stakeholderId, resolution: { companyId } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIMIT,
        select: {
          preferredUnits: true,
          choice: true,
          deemed: true,
          submittedAt: true,
          resolution: {
            select: {
              publicId: true,
              referenceCode: true,
              title: true,
              frozenContent: true,
              params: true,
              type: true,
              status: true,
            },
          },
        },
      }),
      // Recipients are created when a report is sent; a DRAFT has none worth
      // showing on the Member's page.
      ctx.db.memberReportRecipient.findMany({
        where: {
          companyId,
          stakeholderId,
          report: { companyId, status: "SENT" },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIMIT,
        select: {
          sentAt: true,
          firstViewedAt: true,
          report: {
            select: {
              publicId: true,
              title: true,
              type: true,
              sentAt: true,
            },
          },
        },
      }),
      ctx.db.unitTransfer.findMany({
        where: {
          companyId,
          OR: [
            { fromStakeholderId: stakeholderId },
            { toStakeholderId: stakeholderId },
          ],
        },
        orderBy: [
          { noticeReceivedOn: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: LIMIT,
        select: {
          publicId: true,
          fromStakeholderId: true,
          units: true,
          unitClassKind: true,
          status: true,
          effectiveOn: true,
          admittedOn: true,
        },
      }),
    ]);

    return {
      ballots: ballots.map(
        (b): MemberActivityBallot => ({
          resolutionPublicId: b.resolution.publicId,
          referenceCode: b.resolution.referenceCode,
          title: frozenTitle(b.resolution),
          type: b.resolution.type,
          status: b.resolution.status,
          preferredUnits: b.preferredUnits.toFixed(6),
          choice: b.choice,
          deemed: b.deemed,
          submittedAt: b.submittedAt,
        }),
      ),
      reports: reports.map(
        (r): MemberActivityReport => ({
          reportPublicId: r.report.publicId,
          title: r.report.title,
          type: r.report.type,
          sentAt: r.sentAt ?? r.report.sentAt,
          firstViewedAt: r.firstViewedAt,
        }),
      ),
      transfers: transfers.map(
        (t): MemberActivityTransfer => ({
          transferPublicId: t.publicId,
          direction: t.fromStakeholderId === stakeholderId ? "OUT" : "IN",
          units: t.units.toFixed(6),
          unitClassKind: t.unitClassKind,
          status: t.status,
          effectiveOn: t.effectiveOn ? utcDateToYmd(t.effectiveOn) : null,
          admittedOn: t.admittedOn ? utcDateToYmd(t.admittedOn) : null,
        }),
      ),
    };
  });
