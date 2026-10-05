import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createDevLinkSchema, devLinkTypeSchema } from "@/lib/validation";
import { getAccessibleIssue, recordActivity } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/dev-links:
 *   get:
 *     tags: [Issue details]
 *     summary: List development links
 *     description: Branches, pull requests, commits and CI builds — the "Development & Releases" panel. Includes counts per type.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: query, name: type, schema: { type: string, enum: [BRANCH, PULL_REQUEST, COMMIT, BUILD] } }
 *     responses:
 *       200:
 *         description: The links, newest first.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 devLinks: { type: array, items: { $ref: '#/components/schemas/DevLink' } }
 *                 counts:
 *                   type: object
 *                   additionalProperties: { type: integer }
 *                   example: { BRANCH: 2, PULL_REQUEST: 1, COMMIT: 4, BUILD: 1 }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Add a development link
 *     description: Register a branch, PR, commit or build. A VCS/CI webhook can use the same call.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, title]
 *             properties:
 *               type: { type: string, enum: [BRANCH, PULL_REQUEST, COMMIT, BUILD] }
 *               title: { type: string, example: "feat(auth): PKCE" }
 *               url: { type: string, format: uri, nullable: true }
 *               externalId: { type: string, nullable: true, example: "849" }
 *               status: { type: string, nullable: true, example: open }
 *     responses:
 *       201:
 *         description: The link.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 devLink: { $ref: '#/components/schemas/DevLink' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }

  const typeParam = new URL(req.url).searchParams.get("type");
  const typeParsed = typeParam ? devLinkTypeSchema.safeParse(typeParam) : null;
  if (typeParam && !typeParsed?.success) {
    return apiError(400, "Invalid type");
  }

  const [devLinks, grouped] = await Promise.all([
    prisma.devLink.findMany({
      where: { issueId, ...(typeParsed?.success && { type: typeParsed.data }) },
      orderBy: { createdAt: "desc" },
    }),
    prisma.devLink.groupBy({ by: ["type"], where: { issueId }, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(grouped.map((g) => [g.type, g._count._all]));
  return NextResponse.json({ devLinks, counts });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }

  const parsed = await parseJsonBody(req, createDevLinkSchema);
  if (!parsed.success) return parsed.response;
  const { type, title, url, externalId, status } = parsed.data;

  const devLink = await prisma.$transaction(async (tx) => {
    const created = await tx.devLink.create({
      data: {
        issueId,
        createdById: userId,
        type,
        title,
        url: url ?? null,
        externalId: externalId ?? null,
        status: status ?? null,
      },
    });
    await recordActivity(tx, issueId, userId, "DEV_LINK_ADDED", { type, title });
    return created;
  });

  return NextResponse.json({ devLink }, { status: 201 });
}
