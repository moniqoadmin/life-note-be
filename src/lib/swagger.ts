import { createSwaggerSpec } from "next-swagger-doc";

export const getApiDocs = () => {
  return createSwaggerSpec({
    apiFolder: "src/app/api",
    definition: {
      openapi: "3.0.0",
      info: {
        title: "Life Note API",
        version: "1.0.0",
        description: "API documentation for the Life Note backend.",
      },
      servers: [{ url: "/api" }],
      tags: [
        { name: "Auth", description: "Authentication and account management" },
        { name: "Notes", description: "Create, organize, and search nested notes" },
      ],
      components: {
        securitySchemes: {
          // NextAuth (Auth.js) v5 with the JWT session strategy authenticates via an
          // httpOnly session cookie, not an Authorization header — sign in through
          // POST /api/auth/callback/credentials (or the /login page) to obtain it.
          CookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "authjs.session-token",
            description:
              "Session cookie set by NextAuth after signing in via POST /api/auth/callback/credentials or the /login page. In production this is __Secure-authjs.session-token.",
          },
        },
        schemas: {
          Error: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          Message: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          Note: {
            type: "object",
            properties: {
              id: { type: "string" },
              userId: { type: "string" },
              parentId: { type: "string", nullable: true },
              title: { type: "string" },
              content: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
          NoteSummary: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              parentId: { type: "string", nullable: true },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
              childCount: {
                type: "integer",
                description: "Only present when listing via GET /notes.",
              },
            },
          },
          NoteSearchHit: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              parentId: { type: "string", nullable: true },
              updatedAt: { type: "string", format: "date-time" },
              rank: { type: "number", description: "Postgres ts_rank_cd relevance score." },
              snippet: { type: "string", description: "HTML-highlighted content excerpt." },
              breadcrumb: {
                type: "array",
                description: "Ancestor chain, root-first, excluding the note itself.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      security: [],
    },
  });
};
