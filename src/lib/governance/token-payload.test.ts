import { jwtVerify, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import {
  ballotTokenExpiry,
  parseBallotPayload,
  parseReportPayload,
  reportTokenExpiry,
} from "./token-payload";

const EXP = 1_900_000_000;

const ballot = { p: "rb", b: "ballot_1", v: 1, exp: EXP };
const report = { p: "mr", r: "recipient_1", v: 2, exp: EXP };

describe("token-payload", () => {
  test("1: an update-share token is not a ballot or report token", () => {
    const update = {
      companyId: "c1",
      updateId: "u1",
      publicId: "p1",
      recipientId: "r1",
    };
    expect(parseBallotPayload(update)).toBeNull();
    expect(parseReportPayload(update)).toBeNull();
  });

  test("2: an e-sign token is rejected", () => {
    const esign = { id: "t1", rec: "r1" };
    expect(parseBallotPayload(esign)).toBeNull();
    expect(parseReportPayload(esign)).toBeNull();
  });

  test("3: a data-room token is rejected", () => {
    const dataRoom = { companyId: "c1", dataRoomId: "d1", recipientId: "r1" };
    expect(parseBallotPayload(dataRoom)).toBeNull();
    expect(parseReportPayload(dataRoom)).toBeNull();
  });

  test("4: a report payload is not a ballot payload and vice versa", () => {
    expect(parseBallotPayload(report)).toBeNull();
    expect(parseReportPayload(ballot)).toBeNull();
    // Same shape with the other purpose claim is rejected too.
    expect(parseBallotPayload({ ...ballot, p: "mr" })).toBeNull();
    expect(parseReportPayload({ ...report, p: "rb" })).toBeNull();
  });

  test("5: an extra key is rejected", () => {
    expect(parseBallotPayload({ ...ballot, companyId: "c1" })).toBeNull();
    expect(parseReportPayload({ ...report, iat: 1 })).toBeNull();
  });

  test("6: version 0 is rejected", () => {
    expect(parseBallotPayload({ ...ballot, v: 0 })).toBeNull();
    expect(parseReportPayload({ ...report, v: 0 })).toBeNull();
  });

  test("7: valid payloads parse", () => {
    expect(parseBallotPayload(ballot)).toEqual({
      ballotId: "ballot_1",
      version: 1,
    });
    expect(parseReportPayload(report)).toEqual({
      recipientId: "recipient_1",
      version: 2,
    });
  });

  test("7a: malformed values are rejected", () => {
    for (const bad of [
      null,
      undefined,
      "rb",
      [],
      { ...ballot, b: "" },
      { ...ballot, b: "x".repeat(65) },
      { ...ballot, v: 1.5 },
      { ...ballot, v: "1" },
      { ...ballot, exp: undefined },
      { p: "rb", b: "ballot_1", v: 1 },
    ]) {
      expect(parseBallotPayload(bad)).toBeNull();
    }
  });

  test("8: ballot expiry is closesAt + 60 days when earlier than the cap", () => {
    expect(
      ballotTokenExpiry(
        new Date("2027-01-01T00:00:00Z"),
        new Date("2027-01-31T06:59:59.999Z"),
      ).toISOString(),
    ).toBe("2027-04-01T06:59:59.999Z");
  });

  test("9: ballot expiry without a close is sentAt + 400 days", () => {
    expect(
      ballotTokenExpiry(new Date("2027-01-01T00:00:00Z"), null).toISOString(),
    ).toBe("2028-02-05T00:00:00.000Z");
  });

  test("9a: ballot expiry is capped at sentAt + 400 days", () => {
    expect(
      ballotTokenExpiry(
        new Date("2027-01-01T00:00:00Z"),
        new Date("2027-12-31T00:00:00Z"),
      ).toISOString(),
    ).toBe("2028-02-05T00:00:00.000Z");
  });

  test("10: round trip through jose (same calls as src/lib/jwt.ts)", async () => {
    const key = new TextEncoder().encode("test-secret-for-g6-round-trip-only");
    const sign = (data: Record<string, unknown>) =>
      new SignJWT(data).setProtectedHeader({ alg: "HS256" }).sign(key);
    const future = Math.floor(Date.now() / 1000) + 3600;

    const ballotToken = await sign({
      p: "rb",
      b: "ballot_1",
      v: 3,
      exp: future,
    });
    const { payload } = await jwtVerify(ballotToken, key);
    expect(parseBallotPayload(payload)).toEqual({
      ballotId: "ballot_1",
      version: 3,
    });
    expect(parseReportPayload(payload)).toBeNull();

    const reportToken = await sign({ p: "mr", r: "rec_1", v: 1, exp: future });
    const verified = await jwtVerify(reportToken, key);
    expect(parseBallotPayload(verified.payload)).toBeNull();
    expect(parseReportPayload(verified.payload)).toEqual({
      recipientId: "rec_1",
      version: 1,
    });

    // An expired token is rejected by the verifier itself.
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await sign({ p: "rb", b: "ballot_1", v: 1, exp: past });
    await expect(jwtVerify(expired, key)).rejects.toThrow();

    // A token signed with another key is rejected.
    const other = await new SignJWT({
      p: "rb",
      b: "ballot_1",
      v: 1,
      exp: future,
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("a-different-secret-key-value"));
    await expect(jwtVerify(other, key)).rejects.toThrow();
  });

  test("9b: report expiry is sentAt + 400 days", () => {
    expect(
      reportTokenExpiry(new Date("2027-01-01T00:00:00Z")).toISOString(),
    ).toBe("2028-02-05T00:00:00.000Z");
  });
});
