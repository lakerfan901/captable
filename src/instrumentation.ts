import * as Sentry from "@sentry/nextjs";
import { isSentryEnabled } from "@/constants/sentry";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerJobs } = await import("@/jobs/register");

    await registerJobs();

    if (isSentryEnabled) {
      await import("../sentry.server.config");
    }
  }

  if (process.env.NEXT_RUNTIME === "edge" && isSentryEnabled) {
    await import("../sentry.edge.config");
  }
}

// Reports errors from Server Components, route handlers and the proxy. It is a
// no-op when Sentry was not initialised in `register()`.
export const onRequestError = Sentry.captureRequestError;
