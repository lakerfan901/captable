import { describe, expect, it } from "vitest";
import { DEMO_FLAG, demoAllowed } from "./guard";

describe("dashboard demo guard", () => {
  it("is closed in production without the flag", () => {
    expect(demoAllowed("production", undefined)).toBe(false);
    expect(demoAllowed("production", "")).toBe(false);
    expect(demoAllowed("production", "true")).toBe(false);
    expect(demoAllowed("production", "0")).toBe(false);
  });
  it("opens with the explicit flag, or outside production", () => {
    expect(demoAllowed("production", "1")).toBe(true);
    expect(demoAllowed("development", undefined)).toBe(true);
    expect(demoAllowed("test", undefined)).toBe(true);
  });
  it("names the flag", () => {
    expect(DEMO_FLAG).toBe("FINANCIAL_DASHBOARD_DEMO");
  });
});
