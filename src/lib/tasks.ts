import { prisma } from "@/lib/prisma";

/**
 * Fetches a task only if it belongs to the given user. Returns null both when the task
 * doesn't exist and when it belongs to someone else — callers should treat both as a
 * 404, never leak which case it was.
 */
export async function getOwnedTask(userId: string, id: string) {
  return prisma.task.findFirst({ where: { id, userId } });
}
