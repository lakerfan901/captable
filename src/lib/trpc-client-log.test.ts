import { describe, expect, it } from "vitest";
import { shouldLogClientError } from "./trpc-client-log";

describe("shouldLogClientError", () => {
  it("does not log a release refused by the reconciliation check (P38)", () => {
    const refused = Object.assign(new Error("The report figures differ"), {
      data: {
        code: "PRECONDITION_FAILED",
        reconciliation: {
          differences: [
            { field: "grossRevenue", reportCents: 1, ledgerCents: 2 },
          ],
        },
      },
    });
    expect(shouldLogClientError(refused)).toBe(false);
  });

  it("logs every other failure", () => {
    expect(
      shouldLogClientError(
        Object.assign(new Error("x"), {
          data: { code: "BAD_REQUEST", reconciliation: null },
        }),
      ),
    ).toBe(true);
    expect(
      shouldLogClientError(
        Object.assign(new Error("x"), { data: { code: "FORBIDDEN" } }),
      ),
    ).toBe(true);
    expect(shouldLogClientError(new Error("network"))).toBe(true);
    expect(shouldLogClientError(null)).toBe(true);
    expect(shouldLogClientError("boom")).toBe(true);
  });
});
