import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createSopRuleSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";

type Params = { params: Promise<{ id: string; ruleId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id, ruleId } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const existing = await prisma.sopRule.findFirst({ where: { id: ruleId, sopId: id } });
  if (!existing) return apiError(404, "Rule not found");
  const parsed = await parseJsonBody(req, createSopRuleSchema);
  if (!parsed.success) return parsed.response;
  const data = parsed.data;
  const rule = await prisma.$transaction(async (tx) => {
    const updated = await tx.sopRule.update({ where: { id: ruleId }, data: {
      name: data.name, trigger: data.trigger, enabled: data.enabled,
      condition: data.condition as Prisma.InputJsonValue,
      action: data.action as unknown as Prisma.InputJsonValue,
    } });
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return updated;
  });
  return NextResponse.json({ rule });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id, ruleId } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const { count } = await prisma.sopRule.deleteMany({ where: { id: ruleId, sopId: id } });
  if (!count) return apiError(404, "Rule not found");
  await prisma.sop.update({ where: { id }, data: { version: { increment: 1 } } });
  return NextResponse.json({ message: "Rule deleted" });
}
