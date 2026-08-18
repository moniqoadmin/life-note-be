import { NextResponse } from "next/server";
import { getApiDocs } from "@/lib/swagger";

export async function GET() {
  // Mirrors src/app/api-docs/page.tsx — don't serve the raw OpenAPI spec
  // (full request/response/validation shape of the auth API) to the public
  // in production.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.json(getApiDocs());
}
