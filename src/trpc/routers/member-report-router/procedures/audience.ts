import "server-only";
import type { Ymd } from "@/lib/governance/dates";
import { TRANSFER_NOTICE_KINDS } from "@/lib/governance/report-figures";
import { toMicro } from "@/lib/llc/voting";
import type { TPrismaOrTransaction } from "@/server/db";
import { listCurrentMembers } from "@/server/governance/recipients";

// Who receives a member report (03-governance.md G12 send step 2; R22, R22a).
// Always derived on the server; the client never chooses the audience.
//
// - QUARTERLY / ANNUAL / NOTICE: the current Members (`memberStatus MEMBER`
//   with units > 0, suspended Members included). A Financial-Interest-only
//   holder is NEVER one of them.
// - Transfer notices (7.1, 7.2): only the OTHER Preferred Members (Preferred
//   units > 0, not the transferring Member).
// - TAX_K1: exactly the holders a K-1 is attached for (Members and
//   Financial-Interest-only holders; never a PROSPECT).

export interface AudienceMember {
  stakeholderId: string;
  name: string;
  /** noticeEmail ?? email, trimmed ("" when missing) */
  email: string;
}

export type Audience =
  | { ok: true; members: AudienceMember[] }
  | { ok: false; problem: string };

export async function deriveAudience(
  tx: TPrismaOrTransaction,
  companyId: string,
  report: { id: string; type: string; noticeKind: string | null },
  today: Ymd,
): Promise<Audience> {
  if (report.type === "TAX_K1") {
    return { ok: true, members: await k1Holders(tx, companyId, report.id) };
  }

  const current = await listCurrentMembers(tx, companyId, today);
  if (
    report.type === "NOTICE" &&
    (TRANSFER_NOTICE_KINDS as readonly string[]).includes(
      report.noticeKind ?? "",
    )
  ) {
    const transfer = await tx.unitTransfer.findFirst({
      where: { companyId, noticeCopyReportId: report.id },
      select: { fromStakeholderId: true },
    });
    if (!transfer) {
      return { ok: false, problem: "This notice is not linked to a transfer." };
    }
    return {
      ok: true,
      members: current
        .filter(
          (m) =>
            toMicro(m.preferredUnits) > 0n &&
            m.stakeholderId !== transfer.fromStakeholderId,
        )
        .map(toAudience),
    };
  }
  return { ok: true, members: current.map(toAudience) };
}

function toAudience(m: {
  stakeholderId: string;
  name: string;
  email: string;
}): AudienceMember {
  return {
    stakeholderId: m.stakeholderId,
    name: m.name,
    email: m.email.trim(),
  };
}

/** R22a: the distinct holders of this report's K-1 attachments, PROSPECTs excluded. */
export async function k1Holders(
  tx: TPrismaOrTransaction,
  companyId: string,
  reportId: string,
): Promise<AudienceMember[]> {
  const attachments = await tx.memberReportAttachment.findMany({
    where: { reportId, companyId, kind: "K1", stakeholderId: { not: null } },
    select: { stakeholderId: true },
  });
  const ids = [
    ...new Set(
      attachments.flatMap((a) => (a.stakeholderId ? [a.stakeholderId] : [])),
    ),
  ];
  if (ids.length === 0) return [];
  const holders = await tx.stakeholder.findMany({
    where: {
      id: { in: ids },
      companyId,
      memberStatus: { in: ["MEMBER", "FINANCIAL_INTEREST_ONLY"] },
    },
    select: { id: true, name: true, email: true, noticeEmail: true },
  });
  return holders
    .map((h) => ({
      stakeholderId: h.id,
      name: h.name,
      email: (h.noticeEmail ?? h.email).trim(),
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        (a.stakeholderId < b.stakeholderId ? -1 : 1),
    );
}
