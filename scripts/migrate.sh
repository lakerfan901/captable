#!/bin/sh

# The runner image has no node_modules/prisma, so npx downloads the CLI. Pin it
# to the version in package.json: an unpinned `npx prisma` resolves to npm's
# `latest` tag, which can be a pre-release major.
# The CLI reads the database URL from prisma.config.ts (DATABASE_URL).
PRISMA_VERSION="${PRISMA_VERSION:-7.10.1}"

npx --yes "prisma@${PRISMA_VERSION}" migrate deploy
