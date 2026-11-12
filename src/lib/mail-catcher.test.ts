import { describe, expect, test } from "vitest";
import { isMailCatcherUrl } from "./mail-catcher";

describe("isMailCatcherUrl", () => {
  test.each([
    [undefined, true],
    ["smtp://captable:password@smtp:1025", true],
    ["smtp://u:p@localhost:2525", true],
    ["smtps://u:p@smtp.example.com:465", false],
    ["not a url", true],
  ])("%s -> %s", (url, expected) => {
    expect(isMailCatcherUrl(url)).toBe(expected);
  });
});
