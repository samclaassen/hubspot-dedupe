import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ScanProgress } from "./scan-progress";
import { ReviewDashboard } from "./review-dashboard";
import { AutoMergeProgress } from "./auto-merge-progress";

const PAGE_SIZE = 100;

type StatusFilter = "pending" | "merged" | "skipped" | "failed" | "all";

function parseFilter(value: string | undefined): StatusFilter {
  if (
    value === "pending" ||
    value === "merged" ||
    value === "skipped" ||
    value === "failed" ||
    value === "all"
  ) {
    return value;
  }
  return "pending";
}

export default async function ScanPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const filter = parseFilter(search.filter);
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  // Fetch lightweight scan metadata + counts per status
  const scan = await db.scanRun.findUnique({ where: { id } });
  if (!scan) notFound();

  // If scan is still running, show progress without fetching groups
  if (scan.status !== "complete") {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Header startedAt={scan.startedAt} />
        <ScanProgress
          scanId={scan.id}
          initial={{
            status: scan.status,
            stage: scan.stage,
            recordsScanned: scan.recordsScanned,
            totalRecords: scan.totalRecords,
            groupsFound: scan.groupsFound,
            error: scan.error,
          }}
        />
      </div>
    );
  }

  // Get counts per status in a single query
  const statusCounts = await db.duplicateGroup.groupBy({
    by: ["status"],
    where: { scanRunId: id },
    _count: { _all: true },
  });
  const counts = {
    pending: 0,
    merged: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of statusCounts) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row._count._all;
    }
  }
  const total = counts.pending + counts.merged + counts.skipped + counts.failed;

  // Fetch only the groups matching the current filter, paginated
  const whereClause =
    filter === "all" ? { scanRunId: id } : { scanRunId: id, status: filter };
  const filteredTotal =
    filter === "all" ? total : counts[filter as keyof typeof counts] ?? 0;

  const groups = await db.duplicateGroup.findMany({
    where: whereClause,
    include: { members: true },
    orderBy: [{ matchScore: "desc" }, { matchTier: "asc" }, { id: "asc" }],
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
  });

  // Pre-compute auto-merge eligible count (pending AND score ≥ 0.99)
  const autoMergeEligible = await db.duplicateGroup.count({
    where: { scanRunId: id, status: "pending", matchScore: { gte: 0.99 } },
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Header startedAt={scan.startedAt} />
      <AutoMergeProgress
        scanId={scan.id}
        initial={{
          autoMergeStatus: scan.autoMergeStatus,
          autoMergeTotal: scan.autoMergeTotal,
          autoMergedCount: scan.autoMergedCount,
          autoMergeFailedCount: scan.autoMergeFailedCount,
          autoMergeStartedAt: scan.autoMergeStartedAt
            ? scan.autoMergeStartedAt.toISOString()
            : null,
          autoMergeCompletedAt: scan.autoMergeCompletedAt
            ? scan.autoMergeCompletedAt.toISOString()
            : null,
          autoMergeError: scan.autoMergeError,
        }}
      />
      <ReviewDashboard
        scanId={scan.id}
        objectType={scan.objectType}
        recordsScanned={scan.recordsScanned}
        totalRecords={scan.totalRecords}
        counts={counts}
        totalGroups={total}
        filter={filter}
        page={page}
        pageSize={PAGE_SIZE}
        filteredTotal={filteredTotal}
        autoMergeEligible={autoMergeEligible}
        groups={groups.map((g) => ({
          id: g.id,
          matchTier: g.matchTier,
          matchScore: g.matchScore,
          matchReasons: JSON.parse(g.matchReasons),
          status: g.status,
          primaryId: g.primaryId,
          errorMessage: g.errorMessage,
          members: g.members.map((m) => ({
            id: m.id,
            hubspotId: m.hubspotId,
            propertiesSnapshot: JSON.parse(m.propertiesSnapshot),
          })),
        }))}
      />
    </div>
  );
}

function Header({ startedAt }: { startedAt: Date }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground text-sm"
      >
        ← Dashboard
      </Link>
      <div className="text-muted-foreground text-xs">
        Started {startedAt.toLocaleString()}
      </div>
    </div>
  );
}
