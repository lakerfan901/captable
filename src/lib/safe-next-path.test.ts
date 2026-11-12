import { describe, expect, test } from "vitest";
import { safeNextPath } from "./safe-next-path";

describe("safeNextPath", () => {
  test.each([
    ["/abc/admissions/x", "/abc/admissions/x"],
    ["/abc", "/abc"],
    ["/other/x", "/abc"],
    ["https://evil.test", "/abc"],
    ["//evil.test", "/abc"],
    [undefined, "/abc"],
    ["/abcd/x", "/abc"],
  ])("(abc, %s) -> %s", (next, expected) => {
    expect(safeNextPath("abc", next)).toBe(expected);
  });
});
