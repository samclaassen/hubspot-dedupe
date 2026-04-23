// Polling status endpoint. UI hits this every 2s while a scan is running.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;

  const scan = await db.scanRun.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      stage: true,
      recordsScanned: true,
      totalRecords: true,
      groupsFound: true,
      startedAt: true,
      completedAt: true,
      error: true,
      autoMergeStatus: true,
      autoMergeTotal: true,
      autoMergedCount: true,
      autoMergeFailedCount: true,
      autoMergeStartedAt: true,
      autoMergeCompletedAt: true,
      autoMergeError: true,
    },
  });

  if (!scan) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  // Also include live counts of groups by status for UI badges
  const [pending, merged, failed] = await Promise.all([
    db.duplicateGroup.count({ where: { scanRunId: id, status: "pending" } }),
    db.duplicateGroup.count({ where: { scanRunId: id, status: "merged" } }),
    db.duplicateGroup.count({ where: { scanRunId: id, status: "failed" } }),
  ]);

  return NextResponse.json(
    { ...scan, counts: { pending, merged, failed } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
