import { checkHealth } from "@/lib/health";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";

// Health check for the load balancer / uptime monitor. No authentication (the
// proxy lets it through before logging and rate limiting), never cached, and
// the body is only `{"status":"ok"}` or `{"status":"unavailable"}`: no
// version, host or error detail. 200 only when a trivial query reaches the
// database within the timeout, 503 otherwise.

export const dynamic = "force-dynamic";

const log = logger.child({ module: "health" });

async function handler() {
  const result = await checkHealth(async () => {
    try {
      return await db.$queryRaw`SELECT 1`;
    } catch (error) {
      log.error({ err: error }, "Health check: database query failed");
      throw error;
    }
  });
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export { handler as GET, handler as HEAD };
