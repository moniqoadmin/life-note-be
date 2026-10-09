import type { Prisma, SopStepType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stepConfigSchemas, type SopAction } from "@/lib/validation";

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

/** "QA Testing" → "qa-testing"; falls back to "step" for titles with no usable characters. */
export function slugifyStepKey(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "step";
}

/** A key unique within the SOP: the slug, or the slug with -2, -3, ... appended. */
export async function uniqueStepKey(db: Prisma.TransactionClient, sopId: string, base: string, exceptStepId?: string) {
  const taken = new Set(
    (
      await db.sopStep.findMany({
        where: { sopId, key: { startsWith: base }, ...(exceptStepId && { id: { not: exceptStepId } }) },
        select: { key: true },
      })
    ).map((s) => s.key)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/**
 * Validates `config` against the step type's schema and returns it with defaults
 * applied, or an error message for a 400.
 */
export function parseStepConfig(
  type: SopStepType,
  config: unknown
): { success: true; config: Prisma.InputJsonObject } | { success: false; error: string } {
  const parsed = stepConfigSchemas[type].safeParse(config ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `config.${issue.path.join(".")}: ` : "config: ";
    return { success: false, error: `${path}${issue?.message ?? `invalid for a ${type} step`}` };
  }
  return { success: true, config: parsed.data as Prisma.InputJsonObject };
}

/** Step keys an action list points at (GO_TO_STEP, SKIP_STEP, ...). */
export function referencedStepKeys(actions: SopAction[]) {
  return actions.flatMap((a) => ("stepKey" in a ? [a.stepKey] : []));
}

/** Error message naming the first referenced step key that doesn't exist in the SOP, or null. */
export async function findMissingStepKey(sopId: string, keys: string[]) {
  if (!keys.length) return null;
  const existing = new Set(
    (await prisma.sopStep.findMany({ where: { sopId, key: { in: keys } }, select: { key: true } })).map((s) => s.key)
  );
  const missing = keys.find((k) => !existing.has(k));
  return missing ? `No step with key "${missing}" in this SOP` : null;
}
