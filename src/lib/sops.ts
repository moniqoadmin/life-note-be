import { prisma } from "@/lib/prisma";

/**
 * Fetches an SOP the user can use: their own (private or shared), or one shared into a
 * workspace they're a member of. Same 404-on-either-miss contract as getOwnedSop.
 */
export async function getAccessibleSop(userId: string, id: string) {
  return prisma.sop.findFirst({
    where: {
      id,
      OR: [{ userId }, { workspace: { members: { some: { userId } } } }],
    },
  });
}
