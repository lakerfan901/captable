import "server-only";
import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { z } from "zod";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import {
  behaviour,
  describeRequirements,
  type ResolutionType,
} from "@/lib/governance/presets";
import { RichDocSchema } from "@/lib/governance/rich-doc";
import {
  fromMicro,
  isEligible,
  tallyBasis,
  toMicro,
  type VoteBasis,
} from "@/lib/llc/voting";
import type { ResolutionPdfData } from "@/pdf-templates/governance/resolution-pdf";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadLlcCompany } from "./guards";
import { loadEvaluation } from "./tally";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(advancedFormat);

const DASH = "—";

const BASIS_LABEL: Record<VoteBasis, string> = {
  PREFERRED_MAJORITY: "Preferred Majority",
  PREFERRED_SUPERMAJORITY: "Preferred Supermajority",
  DISINTERESTED_MAJORITY: "Majority of the Disinterested Preferred Units",
  DISINTERESTED_67: "67% of the Disinterested Preferred Units",
  DISINTERESTED_70: "70% of the Disinterested Preferred Units",
};

const APPROVAL_ROLE = {
  MANAGER_APPROVAL: "Manager",
  COMMON_MEMBER_APPROVAL: "Common Member",
} as const;

const FrozenContentSchema = z.object({
  title: z.string().optional(),
  doc: RichDocSchema,
  lockedClauses: z.array(z.string()).default([]),
});

function formatDateTime(value: Date | null, zone: string): string {
  if (value === null) return DASH;
  return dayjs(value).tz(zone).format("MMMM D, YYYY h:mm A z");
}

/** `@db.Date` columns are stored at UTC midnight: format without a zone shift. */
function formatDateOnly(value: Date | null): string {
  if (value === null) return DASH;
  return dayjs.utc(value).format("MMMM D, YYYY");
}

/** "1050.000000" -> "1,050"; "900.500000" -> "900.5". */
function formatUnits(units: string): string {
  const [whole = "0", frac = ""] = units.split(".");
  const trimmed = frac.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Basis points (already floored) -> "76.19": two decimals, truncated. */
function formatBps(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
}

/** The percentage wording of G5 for one basis (single source: `describeRequirements`). */
function basisWording(basis: VoteBasis, section: string): string {
  const sentence = describeRequirements([
    { requirement: { kind: "UNIT_VOTE", basis }, section },
  ]);
  const prefix = "Approval required: ";
  const end = sentence.indexOf(".", prefix.length);
  return sentence.slice(prefix.length, end === -1 ? undefined : end);
}

/**
 * Loads a sent resolution, its requirements, ballots, frozen register and
 * company and builds the plain data for `renderResolutionPdf` (G9). Tallies
 * are computed with `tallyBasis` on the frozen register. Dates are formatted
 * in the company time zone (default GOVERNANCE_TIME_ZONE).
 */
export async function buildResolutionPdfData(
  tx: TPrismaOrTransaction,
  resolutionId: string,
): Promise<ResolutionPdfData> {
  const { resolution, requirements, ballots, holders, votes, evaluation } =
    await loadEvaluation(tx, resolutionId);
  const company = await loadLlcCompany(tx, resolution.companyId);
  const zone = company.timezone || GOVERNANCE_TIME_ZONE;
  const preset = behaviour(resolution.type as ResolutionType);

  if (resolution.frozenContent === null || resolution.frozenHash === null) {
    throw new Error(`Resolution ${resolutionId} has no frozen content`);
  }
  const frozen = FrozenContentSchema.parse(resolution.frozenContent);
  const referenceCode = resolution.referenceCode ?? DASH;

  const approvals: ResolutionPdfData["approvals"] = [];
  for (const row of requirements) {
    if (
      row.kind !== "MANAGER_APPROVAL" &&
      row.kind !== "COMMON_MEMBER_APPROVAL"
    )
      continue;
    if (row.approvedAt === null) continue;
    approvals.push({
      role: APPROVAL_ROLE[row.kind],
      approverName: row.approverName ?? "",
      approverCapacity: row.approverCapacity ?? "",
      signedAt: formatDateTime(row.approvedAt, zone),
    });
  }

  const memberSignatures = ballots
    .filter((b) => b.submittedAt !== null && b.choice === "FOR" && !b.deemed)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((b) => ({
      member: b.name,
      signedName: b.signedName ?? "",
      signerCapacity: b.signerCapacity ?? "",
      preferredUnits: formatUnits(b.preferredUnits.toFixed(6)),
      signedAt: formatDateTime(b.submittedAt, zone),
    }));

  const deemedIds = new Set(
    ballots
      .filter((b) => b.deemed && b.choice === "AGAINST")
      .map((b) => b.stakeholderId),
  );

  const tallies: ResolutionPdfData["tallies"] = [];
  for (const [i, row] of requirements.entries()) {
    if (row.kind !== "UNIT_VOTE" || row.basis === null) continue;
    const basis = row.basis;
    const t = tallyBasis(holders, votes, basis);
    let deemedMicro = 0n;
    for (const h of holders) {
      if (deemedIds.has(h.stakeholderId) && isEligible(h, basis)) {
        deemedMicro += toMicro(h.preferredUnits);
      }
    }
    tallies.push({
      basisLabel: BASIS_LABEL[basis],
      section: row.section,
      outstanding: formatUnits(t.denominator),
      requiredUnits: t.minimumFor === null ? DASH : formatUnits(t.minimumFor),
      requiredWording: basisWording(basis, row.section),
      forUnits: formatUnits(t.for),
      forPercent: formatBps(t.forBps),
      against: formatUnits(t.against),
      abstain: formatUnits(t.abstain),
      noResponse: formatUnits(t.notVoted),
      deemedAgainst:
        deemedMicro > 0n ? formatUnits(fromMicro(deemedMicro)) : "",
      result:
        evaluation.results[i]?.state === "PASSED" ? "Approved" : "Not approved",
    });
  }

  return {
    companyName: company.name,
    kindLabel: preset.kindLabel,
    title: frozen.title ?? resolution.title,
    referenceCode,
    frozenHash: resolution.frozenHash,
    facts: {
      reference: referenceCode,
      recordDate: formatDateOnly(resolution.recordDate),
      sent: formatDateTime(resolution.sentAt, zone),
      effective: formatDateTime(resolution.effectiveAt, zone),
    },
    doc: frozen.doc,
    lockedClauses: frozen.lockedClauses,
    approvals,
    hasBallots: preset.hasBallots ? "yes" : "no",
    memberSignatures,
    tallies,
  };
}
