// Polling status endpoint for a list audit run.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;

  const run = await db.listAuditRun.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      stage: true,
      listsScanned: true,
      totalLists: true,
      findingsCount: true,
      startedAt: true,
      completedAt: true,
      error: true,
      bulkDeleteStatus: true,
      bulkDeleteTotal: true,
      bulkDeletedCount: true,
      bulkDeleteFailedCount: true,
      bulkDeleteStartedAt: true,
      bulkDeleteCompletedAt: true,
      bulkDeleteError: true,
    },
  });

  if (!run) {
    return NextResponse.json({ error: "Audit not found" }, { status: 404 });
  }

  const [pending, deleted, acknowledged, failed] = await Promise.all([
    db.listFinding.count({ where: { auditRunId: id, status: "pending" } }),
    db.listFinding.count({ where: { auditRunId: id, status: "deleted" } }),
    db.listFinding.count({ where: { auditRunId: id, status: "acknowledged" } }),
    db.listFinding.count({ where: { auditRunId: id, status: "failed" } }),
  ]);

  return NextResponse.json(
    { ...run, counts: { pending, deleted, acknowledged, failed } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
