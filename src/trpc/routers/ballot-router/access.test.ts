import { describe, expect, it } from "vitest";
import {
  ballotPageState,
  boundRequestMeta,
  classifyBallotAccess,
} from "./access";
import { ZBallotSubmitSchema, ZBallotTokenSchema } from "./schema";

const now = new Date("2027-01-15T12:00:00.000Z");
const row = {
  companyEntityType: "LLC",
  resolutionStatus: "SENT",
  tokenVersion: 2,
  tokenRevokedAt: null,
  tokenExpiresAt: new Date("2027-03-01T00:00:00.000Z"),
};

describe("classifyBallotAccess", () => {
  it("accepts a live link of the current version", () => {
    expect(classifyBallotAccess(row, 2, now)).toBe("OK");
  });
  it("hides non-LLC companies and drafts", () => {
    expect(
      classifyBallotAccess(
        { ...row, companyEntityType: "CORPORATION" },
        2,
        now,
      ),
    ).toBe("NOT_FOUND");
    expect(
      classifyBallotAccess({ ...row, resolutionStatus: "DRAFT" }, 2, now),
    ).toBe("NOT_FOUND");
  });
  it("reports a superseded or revoked link as REPLACED", () => {
    expect(classifyBallotAccess(row, 1, now)).toBe("REPLACED");
    expect(classifyBallotAccess(row, 3, now)).toBe("REPLACED");
    expect(classifyBallotAccess({ ...row, tokenRevokedAt: now }, 2, now)).toBe(
      "REPLACED",
    );
  });
  it("rejects a link past the row's own expiry (boundary included)", () => {
    expect(classifyBallotAccess({ ...row, tokenExpiresAt: now }, 2, now)).toBe(
      "NOT_FOUND",
    );
  });
  it("keeps closed resolutions reachable (withdrawn, effective)", () => {
    for (const status of ["WITHDRAWN", "EFFECTIVE", "FAILED", "EXPIRED"]) {
      expect(
        classifyBallotAccess({ ...row, resolutionStatus: status }, 2, now),
      ).toBe("OK");
    }
  });
});

describe("ballotPageState", () => {
  it("is CLOSED unless SENT, then VOTED once submitted", () => {
    expect(ballotPageState("SENT", null)).toBe("OPEN");
    expect(ballotPageState("SENT", now)).toBe("VOTED");
    expect(ballotPageState("WITHDRAWN", null)).toBe("CLOSED");
    expect(ballotPageState("EFFECTIVE", now)).toBe("CLOSED");
  });
});

describe("boundRequestMeta", () => {
  it("truncates oversized headers", () => {
    const m = boundRequestMeta("1".repeat(500), "u".repeat(5000));
    expect(m.ip).toHaveLength(100);
    expect(m.userAgent).toHaveLength(1000);
  });
});

const TOKEN = "a".repeat(40);
const HASH = "0123456789abcdef".repeat(4);
const valid = {
  token: TOKEN,
  choice: "FOR",
  signedName: "  Alice Example  ",
  bodyHash: HASH,
  assent: true,
};

describe("ZBallotTokenSchema", () => {
  it("bounds the token and rejects extra keys", () => {
    expect(ZBallotTokenSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(ZBallotTokenSchema.safeParse({ token: "short" }).success).toBe(
      false,
    );
    expect(
      ZBallotTokenSchema.safeParse({ token: "a".repeat(2049) }).success,
    ).toBe(false);
    expect(
      ZBallotTokenSchema.safeParse({ token: TOKEN, ballotId: "x" }).success,
    ).toBe(false);
  });
  it("never echoes the token in an error message", () => {
    const secret = "s".repeat(3000);
    const r = ZBallotTokenSchema.safeParse({ token: secret });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain(secret);
  });
});

describe("ZBallotSubmitSchema", () => {
  it("accepts a valid response and trims the name", () => {
    const r = ZBallotSubmitSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data?.signedName).toBe("Alice Example");
  });
  it("requires explicit assent", () => {
    expect(
      ZBallotSubmitSchema.safeParse({ ...valid, assent: false }).success,
    ).toBe(false);
    const { assent: _omit, ...noAssent } = valid;
    expect(ZBallotSubmitSchema.safeParse(noAssent).success).toBe(false);
  });
  it("rejects markup and control characters in the signature", () => {
    for (const signedName of [
      "<b>Alice</b>",
      "Alice\u0000",
      "Alice\nBob",
      "A",
      "x".repeat(201),
    ]) {
      expect(
        ZBallotSubmitSchema.safeParse({ ...valid, signedName }).success,
      ).toBe(false);
    }
    expect(
      ZBallotSubmitSchema.safeParse({ ...valid, signerCapacity: "<i>CEO" })
        .success,
    ).toBe(false);
  });
  it("accepts names with apostrophes, hyphens and accents", () => {
    expect(
      ZBallotSubmitSchema.safeParse({
        ...valid,
        signedName: "Zoë O'Brien-Núñez",
        signerCapacity: "Trustee, Reid Family Trust",
      }).success,
    ).toBe(true);
  });
  it("rejects an unknown choice, a malformed hash and client-supplied ids", () => {
    expect(
      ZBallotSubmitSchema.safeParse({ ...valid, choice: "MAYBE" }).success,
    ).toBe(false);
    expect(
      ZBallotSubmitSchema.safeParse({ ...valid, bodyHash: HASH.toUpperCase() })
        .success,
    ).toBe(false);
    for (const extra of [
      { ballotId: "b1" },
      { resolutionId: "r1" },
      { stakeholderId: "s1" },
      { companyId: "c1" },
      { deemed: true },
    ]) {
      expect(
        ZBallotSubmitSchema.safeParse({ ...valid, ...extra }).success,
      ).toBe(false);
    }
  });
});
