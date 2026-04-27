import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AuditProgress } from "./audit-progress";
import { BulkDisableProgress } from "./bulk-disable-progress";
import { ReviewDashboard, type ReviewFilter } from "./review-dashboard";
import type { ReviewWorkflowFinding } from "./finding-card";

const PAGE_SIZE = 100;

const VALID_FILTERS: ReviewFilter[] = [
  "disable-ready",
  "review",
  "keep",
  "disabled",
  "acknowledged",
  "failed",
  "all",
];

function parseFilter(value: string | undefined): ReviewFilter {
  if (value && VALID_FILTERS.includes(value as ReviewFilter)) {
    return value as ReviewFilter;
  }
  return "disable-ready";
}

export default async function WorkflowAuditReviewPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const filter = parseFilter(search.filter);
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  const run = await db.workflowAuditRun.findUnique({ where: { id } });
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
            workflowsScanned: run.workflowsScanned,
            totalWorkflows: run.totalWorkflows,
            findingsCount: run.findingsCount,
            error: run.error,
          }}
        />
      </div>
    );
  }

  const [
    disableReadyPending,
    reviewPending,
    keepPending,
    disabled,
    acknowledged,
    failed,
    total,
  ] = await Promise.all([
    db.workflowFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "disable" },
    }),
    db.workflowFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "review" },
    }),
    db.workflowFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "keep" },
    }),
    db.workflowFinding.count({ where: { auditRunId: id, status: "disabled" } }),
    db.workflowFinding.count({
      where: { auditRunId: id, status: "acknowledged" },
    }),
    db.workflowFinding.count({ where: { auditRunId: id, status: "failed" } }),
    db.workflowFinding.count({ where: { auditRunId: id } }),
  ]);

  const counts = {
    total,
    disableReady: disableReadyPending,
    review: reviewPending,
    keep: keepPending,
    disabled,
    acknowledged,
    failed,
  };

  const whereClause = buildWhereClause(id, filter);
  const filteredTotal = await db.workflowFinding.count({ where: whereClause });

  const findings = await db.workflowFinding.findMany({
    where: whereClause,
    orderBy: [{ confidence: "desc" }, { name: "asc" }],
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
  });

  const bulkEligible = disableReadyPending;

  const uiFindings: ReviewWorkflowFinding[] = findings.map((f) => ({
    id: f.id,
    hubspotFlowId: f.hubspotFlowId,
    name: f.name,
    flowType: f.flowType,
    objectTypeId: f.objectTypeId,
    isEnabled: f.isEnabled,
    revisionId: f.revisionId,
    description: f.description,
    actionCount: f.actionCount,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    confidence: f.confidence,
    recommendation: f.recommendation,
    status: f.status,
    reason: safeParseReason(f.reasonJson),
    errorMessage: f.errorMessage,
  }));

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Header startedAt={run.startedAt} />
      <BulkDisableProgress
        auditId={run.id}
        initial={{
          bulkDisableStatus: run.bulkDisableStatus,
          bulkDisableTotal: run.bulkDisableTotal,
          bulkDisabledCount: run.bulkDisabledCount,
          bulkDisableFailedCount: run.bulkDisableFailedCount,
          bulkDisableStartedAt: run.bulkDisableStartedAt
            ? run.bulkDisableStartedAt.toISOString()
            : null,
          bulkDisableCompletedAt: run.bulkDisableCompletedAt
            ? run.bulkDisableCompletedAt.toISOString()
            : null,
          bulkDisableError: run.bulkDisableError,
        }}
      />
      <ReviewDashboard
        auditId={run.id}
        totalWorkflows={run.totalWorkflows ?? 0}
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
    case "disable-ready":
      return { auditRunId, status: "pending", recommendation: "disable" };
    case "review":
      return { auditRunId, status: "pending", recommendation: "review" };
    case "keep":
      return { auditRunId, status: "pending", recommendation: "keep" };
    case "disabled":
      return { auditRunId, status: "disabled" };
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
