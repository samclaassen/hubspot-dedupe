// Polling status endpoint for a workflow audit run.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;

  const run = await db.workflowAuditRun.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      stage: true,
      workflowsScanned: true,
      totalWorkflows: true,
      findingsCount: true,
      startedAt: true,
      completedAt: true,
      error: true,
      bulkDisableStatus: true,
      bulkDisableTotal: true,
      bulkDisabledCount: true,
      bulkDisableFailedCount: true,
      bulkDisableStartedAt: true,
      bulkDisableCompletedAt: true,
      bulkDisableError: true,
    },
  });

  if (!run) {
    return NextResponse.json({ error: "Audit not found" }, { status: 404 });
  }

  const [pending, disabled, acknowledged, failed] = await Promise.all([
    db.workflowFinding.count({ where: { auditRunId: id, status: "pending" } }),
    db.workflowFinding.count({ where: { auditRunId: id, status: "disabled" } }),
    db.workflowFinding.count({ where: { auditRunId: id, status: "acknowledged" } }),
    db.workflowFinding.count({ where: { auditRunId: id, status: "failed" } }),
  ]);

  return NextResponse.json(
    { ...run, counts: { pending, disabled, acknowledged, failed } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
