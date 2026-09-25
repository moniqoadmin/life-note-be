import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Progress over the issues in a sprint / epic / release: counts per status plus story
 * points total vs. done, for burndown-style progress bars.
 */
export async function getPlanningStats(where: Prisma.IssueWhereInput) {
  const grouped = await prisma.issue.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
    _sum: { storyPoints: true },
  });

  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const total = grouped.reduce((n, g) => n + g._count._all, 0);
  const done = byStatus.DONE ?? 0;
  const points = grouped.reduce((n, g) => n + (g._sum.storyPoints ?? 0), 0);
  const donePoints = grouped.find((g) => g.status === "DONE")?._sum.storyPoints ?? 0;

  return {
    byStatus,
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    points,
    donePoints,
  };
}
