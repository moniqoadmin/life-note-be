import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createRelationSchema } from "@/lib/validation";
import {
  getAccessibleIssue,
  issueRefSelect,
  listRelations,
  recordActivity,
  relationLabel,
} from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

// Inverse types are stored flipped, so each relation exists once in the table.
const NORMALIZED = {
  BLOCKS: { type: "BLOCKS", flip: false },
  BLOCKED_BY: { type: "BLOCKS", flip: true },
  RELATES_TO: { type: "RELATES_TO", flip: false },
  DUPLICATES: { type: "DUPLICATES", flip: false },
  DUPLICATED_BY: { type: "DUPLICATES", flip: true },
} as const;

/**
 * @swagger
 * /issues/{issueId}/relations:
 *   get:
 *     tags: [Issue details]
 *     summary: List issue relations
 *     description: Both directions, labelled from this issue's point of view ("blocks", "is blocked by", "relates to", ...).
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: The relations.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 relations: { type: array, items: { $ref: '#/components/schemas/IssueRelation' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Link an issue
 *     description: The target must be in the same workspace (any project).
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetIssueId, type]
 *             properties:
 *               targetIssueId: { type: string }
 *               type:
 *                 type: string
 *                 enum: [BLOCKS, BLOCKED_BY, RELATES_TO, DUPLICATES, DUPLICATED_BY]
 *                 description: How this issue relates to the target.
 *     responses:
 *       201:
 *         description: The relation, from this issue's point of view.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 relation: { $ref: '#/components/schemas/IssueRelation' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }

  const relations = await listRelations(issueId);
  return NextResponse.json({ relations });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return apiError(404, "Issue not found");
  }

  const parsed = await parseJsonBody(req, createRelationSchema);
  if (!parsed.success) return parsed.response;
  const { targetIssueId } = parsed.data;

  if (targetIssueId === issueId) {
    return apiError(400, "An issue can't be linked to itself");
  }
  const target = await prisma.issue.findFirst({
    where: { id: targetIssueId, workspaceId: issue.workspaceId },
    select: issueRefSelect,
  });
  if (!target) {
    return apiError(404, "Target issue not found");
  }

  const { type, flip } = NORMALIZED[parsed.data.type];
  const fromIssueId = flip ? targetIssueId : issueId;
  const toIssueId = flip ? issueId : targetIssueId;

  // RELATES_TO is symmetric, so an existing link in either direction counts.
  const duplicate = await prisma.issueRelation.findFirst({
    where: {
      type,
      OR: [
        { fromIssueId, toIssueId },
        ...(type === "RELATES_TO" ? [{ fromIssueId: toIssueId, toIssueId: fromIssueId }] : []),
      ],
    },
  });
  if (duplicate) {
    return apiError(409, "These issues are already linked");
  }

  const relation = await prisma.$transaction(async (tx) => {
    const created = await tx.issueRelation.create({ data: { fromIssueId, toIssueId, type } });
    await recordActivity(tx, issueId, userId, "RELATION_ADDED", {
      type: parsed.data.type,
      issueKey: target.key,
    });
    return created;
  });

  const direction = flip ? "inward" : "outward";
  return NextResponse.json(
    {
      relation: {
        id: relation.id,
        type,
        direction,
        label: relationLabel(type, direction),
        issue: target,
      },
    },
    { status: 201 }
  );
}
