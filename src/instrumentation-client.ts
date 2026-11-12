// Client-side Sentry setup. Next.js runs this file in the browser before the
// app hydrates (it replaces the old `sentry.client.config.ts`).
//
// Sentry is optional: the SDK is only downloaded when NEXT_PUBLIC_SENTRY_DSN is
// set. Public env vars are injected at runtime by <PublicEnvScript /> (see
// src/env.js), which may run after this file, so `@/env` is not imported here
// and the DSN is read once the page has loaded.
import { PUBLIC_ENV_KEY } from "@/constants/env";

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
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
  });

  captureRouterTransitionStart = Sentry.captureRouterTransitionStart;
};

if (document.readyState === "complete") {
  void initSentry();
} else {
  window.addEventListener("load", () => void initSentry(), { once: true });
}

// Instruments client-side navigations once the SDK has loaded.
export const onRouterTransitionStart: CaptureRouterTransitionStart = (
  ...args
) => captureRouterTransitionStart?.(...args);
