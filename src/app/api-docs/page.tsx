import { notFound } from "next/navigation";
import { getApiDocs } from "@/lib/swagger";
import ReactSwagger from "./react-swagger";

export default function ApiDocsPage() {
  // The Swagger UI documents every request/response shape of the auth API
  // (including validation rules) — fine as a dev aid, but not something to
  // serve to anonymous visitors of a production deployment.
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const spec = getApiDocs() as Record<string, unknown>;

  return (
    <section className="bg-white">
      <ReactSwagger spec={spec} />
    </section>
  );
}
