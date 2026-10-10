import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createSopAssignmentSchema, sopAssignmentScopeSchema } from "@/lib/validation";
import { assignmentInclude, scopeAccess, scopeWhere } from "@/lib/sop/assignments";

/**
 * @swagger
 * /sop-assignments:
 *   get:
 *     tags: [SOP Assignments]
 *     summary: List an entity's default SOPs
 *     description: >-
 *       Entity-level SOP defaults, highest priority first. When a task is created (or moved)
 *       under the entity, the first assignment whose `condition` matches the task decides its
 *       SOP — unless the task has its own override. Scopes: NOTE (a module — inherited by every
 *       note below it, nearest ancestor wins), COMPONENT and PROJECT (issues; component first).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: scope, required: true, schema: { type: string, enum: [NOTE, COMPONENT, PROJECT] } }
 *       - { in: query, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ assignments }" }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [SOP Assignments]
 *     summary: Add a default SOP to an entity
 *     description: >-
 *       e.g. `{ "sopId": "…", "scope": { "type": "NOTE", "id": "<module>" }, "condition":
 *       { "field": "issue.labels", "operator": "CONTAINS", "value": "hotfix" }, "priority": 10 }`.
 *       Existing tasks aren't touched; call POST /sop-assignments/{id}/apply for that.
 *     security: [{ CookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sopId, scope]
 *             properties:
 *               sopId: { type: string }
 *               scope: { type: object, properties: { type: { type: string, enum: [NOTE, COMPONENT, PROJECT] }, id: { type: string } } }
 *               condition: { type: object, nullable: true }
 *               priority: { type: integer, default: 0 }
 *     responses:
 *       201: { description: "{ assignment }" }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { searchParams } = new URL(req.url);
  const scope = sopAssignmentScopeSchema.safeParse({ type: searchParams.get("scope"), id: searchParams.get("id") });
  if (!scope.success) return apiError(400, "scope (NOTE | COMPONENT | PROJECT) and id are required");
  if (!(await scopeAccess(session.user.id, scope.data))) return apiError(404, "Entity not found");

  const assignments = await prisma.sopAssignment.findMany({
    where: scopeWhere(scope.data),
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: assignmentInclude,
  });
  return NextResponse.json({ assignments });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const parsed = await parseJsonBody(req, createSopAssignmentSchema);
  if (!parsed.success) return parsed.response;
  const { sopId, scope, condition, priority } = parsed.data;

  const access = await scopeAccess(session.user.id, scope);
  if (!access) return apiError(404, "Entity not found");
  if (!(await access.canUseSop(sopId))) return apiError(400, "That SOP isn't available for this entity");

  const assignment = await prisma.sopAssignment.create({
    data: {
      sopId,
      ...scopeWhere(scope),
      priority,
      condition: condition === null ? Prisma.DbNull : (condition as Prisma.InputJsonValue),
    },
    include: assignmentInclude,
  });
  return NextResponse.json({ assignment }, { status: 201 });
}
