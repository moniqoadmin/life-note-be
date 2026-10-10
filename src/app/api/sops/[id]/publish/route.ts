import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { getAccessibleSop } from "@/lib/sops";
import { buildDefinition, validateDefinition } from "@/lib/sop/definition";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /sops/{id}/publish:
 *   get:
 *     tags: [SOPs]
 *     summary: List published versions and validate the draft
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: >-
 *           `versions` (newest first, without their definitions), `publishedVersion`, the draft
 *           `version`, and `problems` — what would block publishing the draft right now.
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [SOPs]
 *     summary: Publish the draft
 *     description: >-
 *       Validates the draft (step configs per type; every step key referenced by conditions,
 *       branches and GOTO/SKIP actions exists) and freezes it as an immutable version. New
 *       executions run the latest published version; running ones keep the version they started
 *       with. 400 lists the problems; 409 if this draft version is already published.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       201: { description: The new version. }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: Nothing changed since the last publish. }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  const sop = await getAccessibleSop(session.user.id, id);
  if (!sop) return apiError(404, "SOP not found");

  const [versions, steps, rules] = await Promise.all([
    prisma.sopVersion.findMany({
      where: { sopId: id },
      orderBy: { version: "desc" },
      select: { id: true, version: true, createdAt: true, publishedBy: { select: { id: true, name: true, email: true } } },
    }),
    prisma.sopStep.findMany({ where: { sopId: id } }),
    prisma.sopRule.findMany({ where: { sopId: id } }),
  ]);
  return NextResponse.json({
    versions,
    version: sop.version,
    publishedVersion: sop.publishedVersion,
    problems: validateDefinition(buildDefinition(sop, steps, rules)),
  });
}

export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id } = await params;
  if (!(await getAccessibleSop(userId, id))) return apiError(404, "SOP not found");

  const result = await prisma.$transaction(async (tx) => {
    // Lock the SOP so a concurrent edit can't slip between snapshot and version bump.
    await tx.$queryRaw`SELECT "id" FROM "sops" WHERE "id" = ${id} FOR UPDATE`;
    const sop = await tx.sop.findUniqueOrThrow({
      where: { id },
      include: { steps: { orderBy: { position: "asc" } }, rules: { orderBy: { createdAt: "asc" } } },
    });
    if (sop.publishedVersion === sop.version) return { kind: "conflict", version: sop.version } as const;
    const definition = buildDefinition(sop, sop.steps, sop.rules);
    const problems = validateDefinition(definition);
    if (problems.length) return { kind: "invalid", problems } as const;
    const version = await tx.sopVersion.create({
      data: {
        sopId: id,
        version: sop.version,
        definition: definition as unknown as Prisma.InputJsonObject,
        publishedById: userId,
      },
    });
    await tx.sop.update({ where: { id }, data: { publishedVersion: sop.version } });
    return { kind: "published", version } as const;
  });

  if (result.kind === "conflict") return apiError(409, `Version ${result.version} is already published — edit the SOP first`);
  if (result.kind === "invalid") {
    return apiError(400, `Can't publish: ${result.problems[0]}`, {
      code: "SOP_INVALID",
      details: result.problems.map((message) => ({ path: "", message })),
    });
  }
  return NextResponse.json({ version: result.version }, { status: 201 });
}
