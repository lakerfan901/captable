import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { isAccessRefused, unlessRefused } from "./trpc-forbidden";

describe("unlessRefused (a section the role may not read is left out)", () => {
  it("returns the value when the read succeeds", async () => {
    expect(await unlessRefused(() => Promise.resolve(42))).toBe(42);
  });

  it("returns null for the RBAC refusal (UNAUTHORIZED with the policy message)", async () => {
    const read = () =>
      Promise.reject(
        new TRPCError({
          code: "UNAUTHORIZED",
          message: "No matching permissions found for action: audits",
        }),
      );
    expect(await unlessRefused(read)).toBeNull();
  });

  it("returns null for FORBIDDEN", async () => {
    const read = () => Promise.reject(new TRPCError({ code: "FORBIDDEN" }));
    expect(await unlessRefused(read)).toBeNull();
  });

  it("rethrows every other error", async () => {
    await expect(
      unlessRefused(() =>
        Promise.reject(new TRPCError({ code: "INTERNAL_SERVER_ERROR" })),
      ),
    ).rejects.toThrow();
    await expect(
      unlessRefused(() => Promise.reject(new TRPCError({ code: "NOT_FOUND" }))),
    ).rejects.toThrow();
    await expect(
      unlessRefused(() => Promise.reject(new Error("db down"))),
    ).rejects.toThrow("db down");
  });

  it("isAccessRefused only matches a TRPCError with those codes", () => {
    expect(isAccessRefused(new TRPCError({ code: "FORBIDDEN" }))).toBe(true);
    expect(isAccessRefused(new TRPCError({ code: "UNAUTHORIZED" }))).toBe(true);
    expect(isAccessRefused(new TRPCError({ code: "BAD_REQUEST" }))).toBe(false);
    expect(isAccessRefused({ code: "FORBIDDEN" })).toBe(false);
    expect(isAccessRefused(null)).toBe(false);
  });
});
