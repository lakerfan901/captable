// Prisma CLI configuration (Prisma 7+). The CLI no longer reads `.env` or the
// datasource `url` from schema.prisma, so both are handled here.
//
// This file is intentionally self-contained (no `prisma/config` or `dotenv`
// imports): the Docker runner stage runs `prisma migrate deploy` from a
// directory without the project's node_modules.
import type { PrismaConfig } from "prisma";

try {
  process.loadEnvFile();
} catch {
  // No .env file (CI, Docker): rely on the real environment.
}

export default {
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `prisma generate` (postinstall) runs without a database, so do not
    // throw when the variable is missing; commands that need it will fail
    // with a clear error instead.
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies PrismaConfig;
