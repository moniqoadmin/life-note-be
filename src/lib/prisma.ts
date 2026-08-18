import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

// Cache on globalThis outside production so dev's hot-reload reuses the same
// client instead of opening a fresh Postgres connection pool on every file
// change (a common source of "too many connections" during local dev).
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
