import { sentryDataCollection } from "@/constants/sentry-data-collection";
import { env } from "@/env";
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1,
  debug: false,
  dataCollection: sentryDataCollection,
});
