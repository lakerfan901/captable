import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { pagination } from "prisma-extension-pagination";
import { env } from "@/env";
import type { TTemplateFieldMetaType } from "@/trpc/routers/template-field-router/schema";

declare global {
  namespace PrismaJson {
    type TemplateFieldMeta = TTemplateFieldMetaType;
  }
}

function getExtendedClient() {
  // Prisma 7 requires a driver adapter; the URL is no longer read from the
  // schema.
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  return new PrismaClient({
    adapter,
    log: env.LOGS ? ["query", "error", "warn"] : ["error"],
  }).$extends(pagination());
}

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? getExtendedClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type PrismaTransactionalClient = Parameters<
  Parameters<TPrisma["$transaction"]>[0]
>[0];

export type TPrisma = typeof db;

export type TPrismaOrTransaction = TPrisma | PrismaTransactionalClient;
export type ExtendedPrismaClient = ReturnType<typeof getExtendedClient>;
