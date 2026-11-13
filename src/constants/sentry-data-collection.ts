// Sentry SDK v11 replaced `sendDefaultPii` with `dataCollection`, and leaving
// it unset now collects cookies (session tokens), full request/response bodies
// (passwords, cap-table data), user info and database query data. This pins
// the v10 default (`sendDefaultPii` unset), as recommended by Sentry's v11
// migration guide, for every runtime.
type DataCollection = NonNullable<
  NonNullable<
    Parameters<typeof import("@sentry/nextjs").init>[0]
  >["dataCollection"]
>;

const deny = ["forwarded", "-ip", "remote-", "via", "-user"];
// Query parameters that can carry an emailed-link token (`token`), a tRPC
// input holding one (`input`) or a presigned storage URL's signature
// (`X-Amz-*` & co.); see also constants/sentry-scrub.ts, which drops the
// whole query of a presigned URL wherever it appears.
const denyQueryParams = [
  ...deny,
  "input",
  "token",
  "x-amz-",
  "x-goog-",
  "awsaccesskeyid",
  "signature",
  "sig",
  "policy",
  "key-pair-id",
];

export const sentryDataCollection: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny },
    response: { deny },
  },
  httpBodies: [],
  urlQueryParams: { deny: denyQueryParams },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
};
