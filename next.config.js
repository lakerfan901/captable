import withBundleAnalyzer from "@next/bundle-analyzer";
import { withSentryConfig } from "@sentry/nextjs/config";

const bundleAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

// Security headers on every response. The Content-Security-Policy is the
// framing / base / plugin / form-target part only: a full script/style/
// connect policy has not been verified across the app (BlockNote editor,
// react-pdf worker, presigned uploads to the S3 / MinIO origin, Sentry,
// Google sign-in), so it is not shipped yet. Nothing in the app frames its
// own pages (the only iframes are a sandboxed `srcdoc` email preview and the
// Office viewer, which frames Microsoft's origin), hence DENY / 'none'.
const CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

/** @type {{ key: string; value: string }[]} */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  // Production only: a development server on http://localhost must not pin
  // HTTPS for the host.
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          ...SECURITY_HEADERS,
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      // The emailed-link pages carry a credential in the path: no Referer
      // ever leaves them. Listed after the catch-all: for the same key the
      // last matching entry wins.
      {
        source: "/ballots/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        source: "/member-reports/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ]);
  },
  output: process.env.DOCKER_OUTPUT ? "standalone" : undefined,
  // Image builds run on shared hosts and in small VMs: by default Next uses one
  // worker per CPU for page-data collection, which can exhaust memory there.
  ...(process.env.DOCKER_OUTPUT ? { experimental: { cpus: 4 } } : {}),
  // Pin the tracing root to this repo so a stray lockfile in a parent
  // directory cannot change what the standalone build includes.
  outputFileTracingRoot: import.meta.dirname,
  // pdfkit (used by @react-pdf/renderer) loads its standard fonts with dynamic
  // requires that file tracing cannot see, so include them explicitly.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/**"],
  },
  images: {
    remotePatterns: [
      {
        hostname: "randomuser.me",
        protocol: "https",
      },
      {
        hostname: "avatars.githubusercontent.com",
        protocol: "https",
      },
    ],
  },
  // Turbopack is the default bundler for `next dev` and `next build` since
  // Next.js 16, so there is no custom `webpack` function any more (a `webpack`
  // key makes a Turbopack build fail).
  turbopack: {
    resolveAlias: {
      // pdfjs-dist (via react-pdf) optionally requires the native `canvas`
      // package, which must never be bundled.
      canvas: "./src/lib/empty-module.ts",
    },
  },
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "pdf-lib",
    "@aws-sdk/s3-request-presigner",
    "@react-pdf/renderer",
  ],
};

const hasSentry = !!(
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT &&
  process.env.NEXT_PUBLIC_SENTRY_DSN
);

export default hasSentry
  ? withSentryConfig(bundleAnalyzer(nextConfig), {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: true,
      widenClientFileUpload: true,
      // Replaces the removed `disableLogger`; applies to Turbopack and webpack.
      // (`hideSourceMaps` was removed: client source maps are hidden and
      // deleted after upload by default.)
      bundleSizeOptimizations: {
        excludeDebugStatements: true,
      },
    })
  : bundleAnalyzer(nextConfig);
