import { NextResponse } from "next/server";
import { getApiDocs } from "@/lib/swagger";
import { apiError } from "@/lib/api";

export async function GET() {
  // Mirrors src/app/api-docs/page.tsx — don't serve the raw OpenAPI spec
  // (full request/response/validation shape of the auth API) to the public
  // in production.
  if (process.env.NODE_ENV === "production") {
    return apiError(404, "Not found.");
  }

  return NextResponse.json(getApiDocs());
}
