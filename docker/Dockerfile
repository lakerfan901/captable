ARG NODE_VERSION=24.22.3

FROM node:${NODE_VERSION}-alpine AS base
LABEL fly_launch_runtime="Next.js/Prisma"
# The Prisma 7 client is Rust-free and no longer needs OpenSSL, but the Prisma
# CLI's schema engine (`prisma migrate deploy` in scripts/migrate.sh) still
# does. Recent Alpine releases no longer ship libssl in the base image.
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat openssl

FROM base AS deps
WORKDIR /app

# Install Prisma Client - remove if not using Prisma

COPY prisma ./prisma
COPY prisma.config.ts ./

ENV HUSKY=0

# Install dependencies
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN corepack enable pnpm && pnpm i --frozen-lockfile

##### BUILDER

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_OUTPUT=1
ENV SKIP_ENV_VALIDATION=1
RUN corepack enable pnpm && pnpm run build

##### RUNNER

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

ENV DOCKER_OUTPUT=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# copy prisma and migrate script
# prisma.config.ts is self-contained, so the CLI can load it without the
# project's node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.sh ./scripts/migrate.sh
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma/migrations ./prisma/migrations


USER nextjs

EXPOSE 3000

ENV PORT=3000

# Run the migration script
# RUN chmod +x ./scripts/migrate.sh
# ENTRYPOINT [ "./scripts/migrate.sh" ]

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
