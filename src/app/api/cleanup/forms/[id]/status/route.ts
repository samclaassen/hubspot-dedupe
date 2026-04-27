import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;

  const run = await db.formAuditRun.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      stage: true,
      formsScanned: true,
      totalForms: true,
      findingsCount: true,
      startedAt: true,
      completedAt: true,
      error: true,
      bulkArchiveStatus: true,
      bulkArchiveTotal: true,
      bulkArchivedCount: true,
      bulkArchiveFailedCount: true,
      bulkArchiveStartedAt: true,
      bulkArchiveCompletedAt: true,
      bulkArchiveError: true,
    },
  });

  if (!run) {
    return NextResponse.json({ error: "Audit not found" }, { status: 404 });
  }

  const [pending, archived, acknowledged, failed] = await Promise.all([
    db.formFinding.count({ where: { auditRunId: id, status: "pending" } }),
    db.formFinding.count({ where: { auditRunId: id, status: "archived" } }),
    db.formFinding.count({ where: { auditRunId: id, status: "acknowledged" } }),
    db.formFinding.count({ where: { auditRunId: id, status: "failed" } }),
  ]);

  return NextResponse.json(
    { ...run, counts: { pending, archived, acknowledged, failed } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
