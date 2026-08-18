import { z } from "zod";

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number");

export const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email(),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const otpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export const emailOnlySchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  password: passwordSchema,
});

export const createNoteSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title is too long"),
  content: z.string().max(50_000, "Content is too long").default(""),
  parentId: z.string().min(1).nullable().optional(),
});

export const updateNoteSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    content: z.string().max(50_000, "Content is too long").optional(),
    parentId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const searchNotesSchema = z.object({
  q: z.string().min(1, "Search query is required").max(200, "Search query is too long"),
  rootId: z.string().min(1).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
