import { describe, expect, it } from "vitest";
import { checkHealth } from "./health";

describe("checkHealth", () => {
  it("is 200 when the probe succeeds", async () => {
    expect(
      await checkHealth(() => Promise.resolve([{ "?column?": 1 }])),
    ).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("is 503 when the probe rejects, without the error in the body", async () => {
    const result = await checkHealth(() =>
      Promise.reject(
        new Error("connect ECONNREFUSED 10.0.0.5:5432 password=x"),
      ),
    );
    expect(result).toEqual({ status: 503, body: { status: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("is 503 when the probe throws synchronously", async () => {
    const result = await checkHealth(() => {
      throw new Error("boom");
    });
    expect(result.status).toBe(503);
  });

  it("is 503 when the probe hangs past the timeout", async () => {
    const started = Date.now();
    const result = await checkHealth(() => new Promise(() => {}), 50);
    expect(result.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
