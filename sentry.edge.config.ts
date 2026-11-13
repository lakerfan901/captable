import * as Sentry from "@sentry/nextjs";
import { sentryDataCollection } from "@/constants/sentry-data-collection";
import {
  isSignedStorageRequest,
  sentryScrubbing,
} from "@/constants/sentry-scrub";
import { env } from "@/env";

Sentry.init({
  dsn: env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1,
  debug: false,
  dataCollection: sentryDataCollection,
  // Emailed-link tokens and presigned storage URLs never leave in an event,
  // span or breadcrumb.
  ...sentryScrubbing,
  integrations: [
    // No span for a presigned storage URL (breadcrumbs are scrubbed).
    Sentry.winterCGFetchIntegration({
      shouldCreateSpanForRequest: (url) => !isSignedStorageRequest(url),
    }),
  ],
});
