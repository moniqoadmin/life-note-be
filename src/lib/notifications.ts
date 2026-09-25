import type { NotificationType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendNotificationEmail } from "@/lib/mail";

type Db = Prisma.TransactionClient;

// Clients insert mentions as `<@userId>` tokens (rendered as "@Name"), so a mention
// always identifies exactly one user no matter how names/emails change.
const MENTION_PATTERN = /<@([A-Za-z0-9_-]{1,64})>/g;

/** Distinct user ids mentioned in a comment body, in first-mention order. */
export function extractMentionIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_PATTERN)].map((m) => m[1]))];
}

/**
 * Replaces `<@userId>` tokens with `@Name` for plain-text excerpts (emails, previews).
 * Tokens for unknown users become "@unknown" rather than leaking the raw id.
 */
export async function renderMentions(body: string): Promise<string> {
  const ids = extractMentionIds(body);
  if (ids.length === 0) return body;
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  return body.replace(MENTION_PATTERN, (_token, id: string) =>
    names.has(id) ? `@${names.get(id)}` : "@unknown"
  );
}

type IssueInfo = { id: string; key: string; title: string; workspaceId: string };

export type PendingEmail = {
  to: string;
  type: NotificationType;
  actorName: string;
  issue: IssueInfo;
  excerpt?: string;
};

/**
 * Creates notifications for `recipientIds` (minus the actor, and minus anyone who isn't
 * a member of the issue's workspace — a stale or forged mention must never notify an
 * outsider). Runs inside the caller's transaction; returns the emails to send once it
 * commits, so a rolled-back write never emails anyone.
 */
export async function createNotifications(
  db: Db,
  {
    type,
    recipientIds,
    actorId,
    issue,
    commentId,
    excerpt,
  }: {
    type: NotificationType;
    recipientIds: string[];
    actorId: string;
    issue: IssueInfo;
    commentId?: string;
    excerpt?: string;
  }
): Promise<PendingEmail[]> {
  const candidates = recipientIds.filter((id) => id !== actorId);
  if (candidates.length === 0) return [];

  const [members, actor] = await Promise.all([
    db.workspaceMember.findMany({
      where: { workspaceId: issue.workspaceId, userId: { in: candidates } },
      select: { user: { select: { id: true, email: true } } },
    }),
    db.user.findUnique({ where: { id: actorId }, select: { name: true, email: true } }),
  ]);
  if (members.length === 0) return [];

  await db.notification.createMany({
    data: members.map(({ user }) => ({
      userId: user.id,
      actorId,
      type,
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      commentId: commentId ?? null,
      data: { issueKey: issue.key, issueTitle: issue.title, ...(excerpt && { excerpt }) },
    })),
  });

  const actorName = actor?.name ?? actor?.email ?? "Someone";
  return members.map(({ user }) => ({ to: user.email, type, actorName, issue, excerpt }));
}

/**
 * Sends notification emails best-effort: the in-app notification already exists, so an
 * SMTP failure is logged rather than failing the request that triggered it.
 */
export async function sendPendingEmails(emails: PendingEmail[]) {
  const results = await Promise.allSettled(emails.map((e) => sendNotificationEmail(e)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Failed to send notification email:", result.reason);
    }
  }
}

/** First ~200 characters of a comment, mentions rendered as @Name. */
export async function commentExcerpt(body: string) {
  const text = (await renderMentions(body)).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
