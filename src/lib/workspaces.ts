import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Public fields of a user, safe to embed in any workspace-scoped response. */
export const userSelect = { id: true, name: true, email: true, image: true } as const;

/**
 * Where-clause fragment restricting a workspace-scoped row to workspaces the user is a
 * member of. Rows outside the user's workspaces are indistinguishable from missing
 * ones — callers should 404 in both cases, never leak which it was.
 */
export function memberOf(userId: string) {
  return { members: { some: { userId } } };
}

export async function getMembership(userId: string, workspaceId: string) {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

export function canManageWorkspace(role: WorkspaceRole) {
  return role === "OWNER" || role === "ADMIN";
}

export async function isWorkspaceMember(workspaceId: string, userId: string) {
  return (await getMembership(userId, workspaceId)) !== null;
}

export async function getAccessibleProject(userId: string, id: string) {
  return prisma.project.findFirst({ where: { id, workspace: memberOf(userId) } });
}

export async function getAccessibleComponent(userId: string, id: string) {
  return prisma.component.findFirst({
    where: { id, project: { workspace: memberOf(userId) } },
  });
}

export async function getAccessibleSprint(userId: string, id: string) {
  return prisma.sprint.findFirst({ where: { id, workspace: memberOf(userId) } });
}

export async function getAccessibleEpic(userId: string, id: string) {
  return prisma.epic.findFirst({ where: { id, workspace: memberOf(userId) } });
}

export async function getAccessibleRelease(userId: string, id: string) {
  return prisma.release.findFirst({ where: { id, workspace: memberOf(userId) } });
}
