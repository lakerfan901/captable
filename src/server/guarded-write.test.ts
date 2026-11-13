import { describe, expect, it } from "vitest";
import { guardedUpdate, isRecordNotFound } from "./guarded-write";

function prismaError(code: string) {
  return Object.assign(new Error(`prisma ${code}`), { code });
}

describe("isRecordNotFound", () => {
  it("matches P2025 only", () => {
    expect(isRecordNotFound(prismaError("P2025"))).toBe(true);
    expect(isRecordNotFound(prismaError("P2002"))).toBe(false);
    expect(isRecordNotFound(new Error("other"))).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
    expect(isRecordNotFound("P2025")).toBe(false);
  });
});

describe("guardedUpdate", () => {
  it("returns the written row when the guard matched", async () => {
    await expect(
      guardedUpdate(() => Promise.resolve({ id: "a" })),
    ).resolves.toEqual({
      id: "a",
    });
  });

  it("returns null when the guard did not match (P2025)", async () => {
    await expect(
      guardedUpdate(() => Promise.reject(prismaError("P2025"))),
    ).resolves.toBeNull();
  });

  it("rethrows every other error", async () => {
    await expect(
      guardedUpdate(() => Promise.reject(prismaError("P2002"))),
    ).rejects.toThrow("prisma P2002");
    await expect(
      guardedUpdate(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });
});
