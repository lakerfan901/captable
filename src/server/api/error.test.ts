import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { describe, expect, test, vi } from "vitest";
import "../../lib/zod-error-map";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));

const { handleZodError } = await import("./error");

const app = new OpenAPIHono({ defaultHook: handleZodError });
app.openapi(
  createRoute({
    method: "post",
    path: "/items",
    request: {
      query: z.object({
        take: z.coerce.number<number>().min(1).max(50).optional(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              email: z.string().email(),
              status: z.enum(["ACTIVE", "DRAFT"]),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "ok" } },
  }),
  (c) => c.json({ ok: true }, 200),
);

const post = (query: string, body: unknown) =>
  app.request(`/items${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("REST API validation errors", () => {
  test("query validation keeps the v1 error shape and Zod 3 wording", async () => {
    const res = await post("?take=0", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "take: Number must be greater than or equal to 1",
      },
    });
  });

  test("body validation reports the first issue as `path: message`", async () => {
    const missing = await post("", {});
    expect(await missing.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "name: Required" },
    });

    const invalid = await post("", {
      name: "x",
      email: "nope",
      status: "ACTIVE",
    });
    expect(await invalid.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "email: Invalid email" },
    });

    const badEnum = await post("", { name: "x", email: "a@b.co", status: "x" });
    expect(await badEnum.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message:
          "status: Invalid enum value. Expected 'ACTIVE' | 'DRAFT', received 'x'",
      },
    });
  });

  test("valid input passes", async () => {
    const res = await post("?take=5", {
      name: "x",
      email: "a@b.co",
      status: "DRAFT",
    });
    expect(res.status).toBe(200);
  });
});
