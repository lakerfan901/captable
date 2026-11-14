// Client-side Sentry setup. Next.js runs this file in the browser before the
// app hydrates (it replaces the old `sentry.client.config.ts`).
//
// Sentry is optional: the SDK is only downloaded when NEXT_PUBLIC_SENTRY_DSN is
// set. Public env vars are injected at runtime by <PublicEnvScript /> (see
// src/env.js), which may run after this file, so `@/env` is not imported here
// (evaluating it too early would cache missing public values app-wide).

import { z } from "zod";
import { PUBLIC_ENV_KEY } from "@/constants/env";
import { sentryDataCollection } from "@/constants/sentry-data-collection";
import {
  isSignedStorageRequest,
  sentryScrubbing,
} from "@/constants/sentry-scrub";
import { redactDeep } from "@/lib/token-redaction";

// The Content-Security-Policy (src/lib/csp.ts) has no 'unsafe-eval'. zod 4
// otherwise probes `Function("")` on its first object parse to decide
// whether to JIT-compile parsers, which the browser blocks and reports as a
// CSP violation on every page. Interpreted parsing is what runs anyway.
z.config({ jitless: true });

type CaptureRouterTransitionStart =
  typeof import("@sentry/nextjs").captureRouterTransitionStart;

let captureRouterTransitionStart: CaptureRouterTransitionStart | undefined;

const readDsn = (): string | undefined =>
  // biome-ignore lint/suspicious/noExplicitAny: runtime-injected global
  (window as any)[PUBLIC_ENV_KEY]?.NEXT_PUBLIC_SENTRY_DSN ||
  process.env.NEXT_PUBLIC_SENTRY_DSN ||
  undefined;

const initSentry = async () => {
  const dsn = readDsn();
  if (!dsn) return;

  const Sentry = await import("@sentry/nextjs");

  Sentry.init({
    dsn,
    tracesSampleRate: 1,
    debug: false,
    dataCollection: sentryDataCollection,
    // Emailed-link tokens (ballot and member-report paths, `input` / `token`
    // query parameters) and presigned storage URLs never leave in an event,
    // span or breadcrumb.
    ...sentryScrubbing,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    integrations: [
      // No span for a presigned storage URL (uploads PUT to S3 / MinIO with
      // a reusable signed URL); its fetch breadcrumb is scrubbed.
      Sentry.browserTracingIntegration({
        shouldCreateSpanForRequest: (url) => !isSignedStorageRequest(url),
      }),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
        // Recorded navigations and network requests carry URLs.
        beforeAddRecordingEvent: (event) => redactDeep(event),
      }),
    ],
  });
  // Replay events (their `urls` list) do not pass through `beforeSend`.
  Sentry.addEventProcessor((event) =>
    event.type === "replay_event" ? redactDeep(event) : event,
  );

  captureRouterTransitionStart = Sentry.captureRouterTransitionStart;
};

// Initialise right away when the DSN is already known (build-time value, or
// PublicEnvScript already ran); otherwise wait until the page has loaded.
if (readDsn() || document.readyState === "complete") {
  void initSentry();
} else {
  window.addEventListener("load", () => void initSentry(), { once: true });
}

// Instruments client-side navigations once the SDK has loaded.
export const onRouterTransitionStart: CaptureRouterTransitionStart = (
  ...args
) => captureRouterTransitionStart?.(...args);
