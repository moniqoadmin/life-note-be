import type { SopRule } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeActions, normalizeTrigger } from "@/lib/sop/definition";

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

/** API shape of a rule: `actions` is always an array (older rows stored one `action`). */
export function serializeRule(rule: SopRule) {
  const { action, ...rest } = rule;
  return { ...rest, trigger: normalizeTrigger(rule.trigger), actions: normalizeActions(action) };
}
