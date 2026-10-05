import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateDevLinkSchema } from "@/lib/validation";
import { getAccessibleIssue } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string; linkId: string }> };

/**
 * @swagger
 * /issues/{issueId}/dev-links/{linkId}:
 *   patch:
 *     tags: [Issue details]
 *     summary: Update a development link
 *     description: e.g. mark a PR merged or a build passing.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: linkId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               url: { type: string, format: uri, nullable: true }
 *               externalId: { type: string, nullable: true }
 *               status: { type: string, nullable: true, example: merged }
 *     responses:
 *       200:
 *         description: The updated link.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 devLink: { $ref: '#/components/schemas/DevLink' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Issue details]
 *     summary: Remove a development link
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: linkId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, linkId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  if (!(await prisma.devLink.findFirst({ where: { id: linkId, issueId } }))) {
    return apiError(404, "Link not found");
  }

  const parsed = await parseJsonBody(req, updateDevLinkSchema);
  if (!parsed.success) return parsed.response;

  const devLink = await prisma.devLink.update({ where: { id: linkId }, data: parsed.data });

  return NextResponse.json({ devLink });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, linkId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const { count } = await prisma.devLink.deleteMany({ where: { id: linkId, issueId } });
  if (count === 0) {
    return apiError(404, "Link not found");
  }

  return NextResponse.json({ message: "Link removed" });
}
