import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { apiError } from "@/lib/api";
import { SOP_CATALOG } from "@/lib/sop/catalog";

/**
 * @swagger
 * /sop-meta:
 *   get:
 *     tags: [SOPs]
 *     summary: SOP engine vocabulary
 *     description: >-
 *       Step types and their config keys, condition fields and operators, rule triggers and
 *       actions — everything a client needs to build SOP / condition / rule editors.
 *     security: [{ CookieAuth: [] }]
 *     responses:
 *       200: { description: The catalog. }
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  return NextResponse.json(SOP_CATALOG);
}
