import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionEvidenceSchema } from "../schema";

// resolution.evidence (03-governance.md G8): the Manager's proof-of-vote
// record as CSV, one row per ballot. Contains no link or token. The last two
// columns show a ballot whose email was changed after send (H1); the
// original address is the frozen register entry's (ballots copy it at send).

const HEADER = [
  "name",
  "email",
  "units",
  "countsPreferred",
  "countsDisinterested",
  "choice",
  "deemed",
  "signedName",
  "signerCapacity",
  "submittedAt",
  "submitIp",
  "submitUserAgent",
  "bodyHash",
  "invitedAt",
  "firstViewedAt",
  "reminderCount",
  "Ballot email changed after send",
  "Original ballot email",
] as const;

/**
 * CSV cell: formula-injection guard (a leading = + - @ TAB or CR is prefixed
 * with '), then RFC 4180 quoting.
 */
function csvCell(value: string | number | boolean | Date | null): string {
  let s =
    value === null
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const evidenceProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZResolutionEvidenceSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const resolution = await ctx.db.resolution.findFirst({
      where: { publicId: input.publicId, companyId },
      select: {
        id: true,
        publicId: true,
        referenceCode: true,
        snapshotId: true,
      },
    });
    if (!resolution) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Resolution not found.",
      });
    }
    const ballots = await ctx.db.resolutionBallot.findMany({
      where: { resolutionId: resolution.id, companyId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        stakeholderId: true,
        name: true,
        email: true,
        preferredUnits: true,
        countsPreferred: true,
        countsDisinterested: true,
        choice: true,
        deemed: true,
        signedName: true,
        signerCapacity: true,
        submittedAt: true,
        submitIp: true,
        submitUserAgent: true,
        bodyHash: true,
        invitedAt: true,
        firstViewedAt: true,
        reminderCount: true,
      },
    });

    const entries = resolution.snapshotId
      ? await ctx.db.recordSnapshotEntry.findMany({
          where: { snapshotId: resolution.snapshotId, companyId },
          select: { stakeholderId: true, email: true },
        })
      : [];
    const originalEmail = new Map(
      entries.map((e) => [e.stakeholderId, e.email.trim()]),
    );

    const lines = [HEADER.map(csvCell).join(",")];
    for (const b of ballots) {
      const original = originalEmail.get(b.stakeholderId) ?? b.email;
      lines.push(
        [
          b.name,
          b.email,
          b.preferredUnits.toFixed(6),
          b.countsPreferred,
          b.countsDisinterested,
          b.choice,
          b.deemed,
          b.signedName,
          b.signerCapacity,
          b.submittedAt,
          b.submitIp,
          b.submitUserAgent,
          b.bodyHash,
          b.invitedAt,
          b.firstViewedAt,
          b.reminderCount,
          original === b.email ? "no" : "yes",
          original,
        ]
          .map(csvCell)
          .join(","),
      );
    }

    const base = (resolution.referenceCode ?? resolution.publicId).replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    return {
      fileName: `${base}-evidence.csv`,
      csv: `${lines.join("\r\n")}\r\n`,
    };
  });
