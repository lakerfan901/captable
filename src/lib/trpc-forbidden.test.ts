import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { isForbidden, unlessForbidden } from "./trpc-forbidden";

describe("unlessForbidden (a section the role may not read is left out)", () => {
  it("returns the value when the read succeeds", async () => {
    expect(await unlessForbidden(() => Promise.resolve(42))).toBe(42);
  });

  it("returns null for FORBIDDEN (custom role without the subject)", async () => {
    const read = () =>
      Promise.reject(
        new TRPCError({
          code: "FORBIDDEN",
          message: "No matching permissions",
        }),
      );
    expect(await unlessForbidden(read)).toBeNull();
  });

  it("rethrows every other error", async () => {
    await expect(
      unlessForbidden(() =>
        Promise.reject(new TRPCError({ code: "INTERNAL_SERVER_ERROR" })),
      ),
    ).rejects.toThrow();
    await expect(
      unlessForbidden(() =>
        Promise.reject(new TRPCError({ code: "NOT_FOUND" })),
      ),
    ).rejects.toThrow();
    await expect(
      unlessForbidden(() => Promise.reject(new Error("db down"))),
    ).rejects.toThrow("db down");
  });

  it("isForbidden only matches a TRPCError with that code", () => {
    expect(isForbidden(new TRPCError({ code: "FORBIDDEN" }))).toBe(true);
    expect(isForbidden(new TRPCError({ code: "UNAUTHORIZED" }))).toBe(false);
    expect(isForbidden({ code: "FORBIDDEN" })).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});
