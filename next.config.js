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

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: process.env.DOCKER_OUTPUT ? "standalone" : undefined,
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
