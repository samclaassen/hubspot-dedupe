import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AuditProgress } from "./audit-progress";
import { BulkDeleteProgress } from "./bulk-delete-progress";
import { ReviewDashboard, type ReviewFilter } from "./review-dashboard";
import type { ReviewListFinding } from "./finding-card";

const PAGE_SIZE = 100;

const VALID_FILTERS: ReviewFilter[] = [
  "delete-ready",
  "review",
  "keep",
  "deleted",
  "acknowledged",
  "failed",
  "all",
];

function parseFilter(value: string | undefined): ReviewFilter {
  if (value && VALID_FILTERS.includes(value as ReviewFilter)) {
    return value as ReviewFilter;
  }
  return "delete-ready";
}

export default async function ListAuditReviewPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const filter = parseFilter(search.filter);
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  const run = await db.listAuditRun.findUnique({ where: { id } });
  if (!run) notFound();

  if (run.status !== "complete") {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Header startedAt={run.startedAt} />
        <AuditProgress
          auditId={run.id}
          initial={{
            status: run.status,
            stage: run.stage,
            listsScanned: run.listsScanned,
            totalLists: run.totalLists,
            findingsCount: run.findingsCount,
            error: run.error,
          }}
        />
      </div>
    );
  }

  const [
    deleteReadyPending,
    reviewPending,
    keepPending,
    deleted,
    acknowledged,
    failed,
    total,
  ] = await Promise.all([
    db.listFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "delete" },
    }),
    db.listFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "review" },
    }),
    db.listFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "keep" },
    }),
    db.listFinding.count({ where: { auditRunId: id, status: "deleted" } }),
    db.listFinding.count({
      where: { auditRunId: id, status: "acknowledged" },
    }),
    db.listFinding.count({ where: { auditRunId: id, status: "failed" } }),
    db.listFinding.count({ where: { auditRunId: id } }),
  ]);

  const counts = {
    total,
    deleteReady: deleteReadyPending,
    review: reviewPending,
    keep: keepPending,
    deleted,
    acknowledged,
    failed,
  };

  const whereClause = buildWhereClause(id, filter);
  const filteredTotal = await db.listFinding.count({ where: whereClause });

  const findings = await db.listFinding.findMany({
    where: whereClause,
    orderBy: [{ confidence: "desc" }, { name: "asc" }],
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
  });

  const bulkEligible = deleteReadyPending;

  const uiFindings: ReviewListFinding[] = findings.map((f) => ({
    id: f.id,
    hubspotListId: f.hubspotListId,
    name: f.name,
    processingType: f.processingType,
    objectTypeId: f.objectTypeId,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    filtersUpdatedAt: f.filtersUpdatedAt ? f.filtersUpdatedAt.toISOString() : null,
    memberCount: f.memberCount,
    referenceCount: f.referenceCount,
    lastRecordAddedAt: f.lastRecordAddedAt ? f.lastRecordAddedAt.toISOString() : null,
    lastRecordRemovedAt: f.lastRecordRemovedAt
      ? f.lastRecordRemovedAt.toISOString()
      : null,
    confidence: f.confidence,
    recommendation: f.recommendation,
    status: f.status,
    reason: safeParseReason(f.reasonJson),
    errorMessage: f.errorMessage,
  }));

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Header startedAt={run.startedAt} />
      <BulkDeleteProgress
        auditId={run.id}
        initial={{
          bulkDeleteStatus: run.bulkDeleteStatus,
          bulkDeleteTotal: run.bulkDeleteTotal,
          bulkDeletedCount: run.bulkDeletedCount,
          bulkDeleteFailedCount: run.bulkDeleteFailedCount,
          bulkDeleteStartedAt: run.bulkDeleteStartedAt
            ? run.bulkDeleteStartedAt.toISOString()
            : null,
          bulkDeleteCompletedAt: run.bulkDeleteCompletedAt
            ? run.bulkDeleteCompletedAt.toISOString()
            : null,
          bulkDeleteError: run.bulkDeleteError,
        }}
      />
      <ReviewDashboard
        auditId={run.id}
        totalLists={run.totalLists ?? 0}
        findings={uiFindings}
        counts={counts}
        bulkEligible={bulkEligible}
        filter={filter}
        page={page}
        pageSize={PAGE_SIZE}
        filteredTotal={filteredTotal}
      />
    </div>
  );
}

function buildWhereClause(auditRunId: string, filter: ReviewFilter) {
  switch (filter) {
    case "delete-ready":
      return { auditRunId, status: "pending", recommendation: "delete" };
    case "review":
      return { auditRunId, status: "pending", recommendation: "review" };
    case "keep":
      return { auditRunId, status: "pending", recommendation: "keep" };
    case "deleted":
      return { auditRunId, status: "deleted" };
    case "acknowledged":
      return { auditRunId, status: "acknowledged" };
    case "failed":
      return { auditRunId, status: "failed" };
    case "all":
      return { auditRunId };
  }
}

function safeParseReason(json: string) {
  try {
    const parsed = JSON.parse(json) as {
      factors?: Array<{ factor: string; weight: number; triggered: boolean }>;
      notes?: string[];
    };
    return {
      factors: parsed.factors ?? [],
      notes: parsed.notes ?? [],
    };
  } catch {
    return { factors: [], notes: [] };
  }
}

function Header({ startedAt }: { startedAt: Date }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <Link
        href="/cleanup"
        className="text-muted-foreground hover:text-foreground text-sm"
      >
        ← Cleanup
      </Link>
      <div className="text-muted-foreground text-xs">
        Started {startedAt.toLocaleString()}
      </div>
    </div>
  );
}
