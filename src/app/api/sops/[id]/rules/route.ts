import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createSopRuleSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const rules = await prisma.sopRule.findMany({ where: { sopId: id }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ rules });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const parsed = await parseJsonBody(req, createSopRuleSchema);
  if (!parsed.success) return parsed.response;
  const data = parsed.data;
  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.sopRule.create({ data: {
      sopId: id, name: data.name, trigger: data.trigger,
      condition: data.condition as Prisma.InputJsonValue,
      action: data.action as unknown as Prisma.InputJsonValue, enabled: data.enabled,
    } });
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return created;
  });
  return NextResponse.json({ rule }, { status: 201 });
}
