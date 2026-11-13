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
    // Never record a presigned storage URL (spans or breadcrumbs). This
    // replaces the SDK's own Http integration, so its Next.js setting is
    // kept: Next.js instruments incoming requests itself.
    Sentry.httpIntegration({
      disableIncomingRequestSpans: true,
      ignoreOutgoingRequests: isSignedStorageRequest,
    }),
    Sentry.nativeNodeFetchIntegration({
      ignoreOutgoingRequests: isSignedStorageRequest,
    }),
  ],
});
