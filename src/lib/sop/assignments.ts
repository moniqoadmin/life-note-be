import type { SopAssignment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccessibleSop } from "@/lib/sops";
import type { SubjectRef } from "@/lib/sop/subjects";

export type AssignmentScope = { type: "NOTE" | "COMPONENT" | "PROJECT"; id: string };

export const scopeWhere = (scope: AssignmentScope) =>
  scope.type === "NOTE" ? { noteId: scope.id } : scope.type === "COMPONENT" ? { componentId: scope.id } : { projectId: scope.id };

export const scopeOf = (a: Pick<SopAssignment, "noteId" | "componentId" | "projectId">): AssignmentScope =>
  a.noteId ? { type: "NOTE", id: a.noteId } : a.componentId ? { type: "COMPONENT", id: a.componentId } : { type: "PROJECT", id: a.projectId! };

/**
 * Whether `userId` may manage SOP defaults on this entity, and which SOPs it may use:
 * a note's own SOPs (private or shared with the owner's workspaces), or SOPs shared
 * into the component's / project's workspace. Null = no access (treat as 404).
 */
export async function scopeAccess(userId: string, scope: AssignmentScope) {
  if (scope.type === "NOTE") {
    const note = await prisma.note.findFirst({ where: { id: scope.id, userId }, select: { title: true } });
    return note ? { name: note.title, canUseSop: async (sopId: string) => !!(await getAccessibleSop(userId, sopId)) } : null;
  }
  const project =
    scope.type === "PROJECT"
      ? await prisma.project.findFirst({
          where: { id: scope.id, workspace: { members: { some: { userId } } } },
          select: { workspaceId: true, name: true },
        })
      : await prisma.component
          .findFirst({
            where: { id: scope.id, project: { workspace: { members: { some: { userId } } } } },
            select: { name: true, project: { select: { workspaceId: true } } },
          })
          .then((c) => c && { workspaceId: c.project.workspaceId, name: c.name });
  if (!project) return null;
  return {
    name: project.name,
    canUseSop: async (sopId: string) =>
      !!(await prisma.sop.findFirst({ where: { id: sopId, workspaceId: project.workspaceId }, select: { id: true } })),
  };
}

/** Every subject that could inherit from this entity (capped), for "apply to existing". */
export async function subjectsInScope(scope: AssignmentScope, limit = 500): Promise<SubjectRef[]> {
  if (scope.type === "NOTE") {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE subtree AS (
        SELECT "id", 0 AS depth FROM "notes" WHERE "parentId" = ${scope.id}
        UNION ALL
        SELECT n."id", s.depth + 1 FROM "notes" n JOIN subtree s ON n."parentId" = s."id" WHERE s.depth < 50
      )
      SELECT "id" FROM subtree LIMIT ${limit}
    `;
    return rows.map((r) => ({ type: "NOTE", id: r.id }));
  }
  const issues = await prisma.issue.findMany({
    where: scope.type === "COMPONENT" ? { componentId: scope.id } : { projectId: scope.id },
    select: { id: true },
    take: limit,
  });
  return issues.map((i) => ({ type: "ISSUE", id: i.id }));
}

export const assignmentInclude = {
  sop: { select: { id: true, title: true, version: true, publishedVersion: true } },
} as const;
