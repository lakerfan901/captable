import withBundleAnalyzer from "@next/bundle-analyzer";
import { withSentryConfig } from "@sentry/nextjs";

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
  webpack: (config, { isServer }) => {
    /**
     * Critical: prevents " ⨯ ./node_modules/canvas/build/Release/canvas.node
     * Module parse failed: Unexpected character '�' (1:0)" error
     */
    config.resolve.alias.canvas = false;

    if (isServer) {
      config.ignoreWarnings = [{ module: /opentelemetry/ }];
    }

    return config;
  },
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "pdf-lib",
    "@aws-sdk/s3-request-presigner",
    "@react-pdf/renderer",
  ],
  eslint: {
    ignoreDuringBuilds: true,
  },
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
      hideSourceMaps: true,
      disableLogger: true,
    })
  : bundleAnalyzer(nextConfig);
