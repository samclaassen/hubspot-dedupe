import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AuditProgress } from "./audit-progress";
import { BulkArchiveProgress } from "./bulk-archive-progress";
import { ReviewDashboard, type ReviewFilter } from "./review-dashboard";
import type { ReviewFinding } from "./finding-card";

const PAGE_SIZE = 100;

const VALID_FILTERS: ReviewFilter[] = [
  "archive-ready",
  "review",
  "keep",
  "archived",
  "acknowledged",
  "failed",
  "all",
];

function parseFilter(value: string | undefined): ReviewFilter {
  if (value && VALID_FILTERS.includes(value as ReviewFilter)) {
    return value as ReviewFilter;
  }
  return "archive-ready";
}

export default async function PropertyAuditReviewPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const filter = parseFilter(search.filter);
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  const run = await db.propertyAuditRun.findUnique({ where: { id } });
  if (!run) notFound();

  const objectTypes = JSON.parse(run.objectTypes) as string[];

  // If the audit is still running, show progress instead of findings.
  if (run.status !== "complete") {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Header startedAt={run.startedAt} />
        <AuditProgress
          auditId={run.id}
          initial={{
            status: run.status,
            stage: run.stage,
            propertiesScanned: run.propertiesScanned,
            totalProperties: run.totalProperties,
            findingsCount: run.findingsCount,
            error: run.error,
          }}
        />
      </div>
    );
  }

  // Counts per recommendation + status
  const [
    archiveReadyPending,
    reviewPending,
    keepPending,
    archived,
    acknowledged,
    failed,
    total,
  ] = await Promise.all([
    db.propertyFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "archive" },
    }),
    db.propertyFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "review" },
    }),
    db.propertyFinding.count({
      where: { auditRunId: id, status: "pending", recommendation: "keep" },
    }),
    db.propertyFinding.count({
      where: { auditRunId: id, status: "archived" },
    }),
    db.propertyFinding.count({
      where: { auditRunId: id, status: "acknowledged" },
    }),
    db.propertyFinding.count({ where: { auditRunId: id, status: "failed" } }),
    db.propertyFinding.count({ where: { auditRunId: id } }),
  ]);

  const counts = {
    total,
    archiveReady: archiveReadyPending,
    review: reviewPending,
    keep: keepPending,
    archived,
    acknowledged,
    failed,
  };

  const whereClause = buildWhereClause(id, filter);
  const filteredTotal = await db.propertyFinding.count({ where: whereClause });

  const findings = await db.propertyFinding.findMany({
    where: whereClause,
    orderBy: [{ confidence: "desc" }, { propertyName: "asc" }],
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
  });

  const bulkEligible = archiveReadyPending;

  const uiFindings: ReviewFinding[] = findings.map((f) => {
    const reason = safeParseReason(f.reasonJson);
    const workflowRefs = f.workflowIdsJson
      ? (safeParse<Array<{ id: string; name: string | null }>>(
          f.workflowIdsJson
        ) ?? [])
      : [];
    return {
      id: f.id,
      objectType: f.objectType,
      propertyName: f.propertyName,
      propertyLabel: f.propertyLabel,
      propertyGroupName: f.propertyGroupName,
      fieldType: f.fieldType,
      dataType: f.dataType,
      populatedCount: f.populatedCount,
      recordBase: f.recordBase,
      hasFormula: f.hasFormula,
      hubspotDefined: f.hubspotDefined,
      archivable: f.archivable,
      hidden: f.hidden,
      formField: f.formField,
      referencedInWorkflows: f.referencedInWorkflows,
      workflowRefs,
      lastModifiedAt: f.lastModifiedAt ? f.lastModifiedAt.toISOString() : null,
      confidence: f.confidence,
      recommendation: f.recommendation,
      status: f.status,
      reason,
      errorMessage: f.errorMessage,
    };
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Header startedAt={run.startedAt} />
      <BulkArchiveProgress
        auditId={run.id}
        initial={{
          bulkArchiveStatus: run.bulkArchiveStatus,
          bulkArchiveTotal: run.bulkArchiveTotal,
          bulkArchivedCount: run.bulkArchivedCount,
          bulkArchiveFailedCount: run.bulkArchiveFailedCount,
          bulkArchiveStartedAt: run.bulkArchiveStartedAt
            ? run.bulkArchiveStartedAt.toISOString()
            : null,
          bulkArchiveCompletedAt: run.bulkArchiveCompletedAt
            ? run.bulkArchiveCompletedAt.toISOString()
            : null,
          bulkArchiveError: run.bulkArchiveError,
        }}
      />
      <ReviewDashboard
        auditId={run.id}
        objectTypes={objectTypes}
        totalProperties={run.totalProperties ?? 0}
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
    case "archive-ready":
      return { auditRunId, status: "pending", recommendation: "archive" };
    case "review":
      return { auditRunId, status: "pending", recommendation: "review" };
    case "keep":
      return { auditRunId, status: "pending", recommendation: "keep" };
    case "archived":
      return { auditRunId, status: "archived" };
    case "acknowledged":
      return { auditRunId, status: "acknowledged" };
    case "failed":
      return { auditRunId, status: "failed" };
    case "all":
      return { auditRunId };
  }
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function safeParseReason(json: string) {
  const fallback = { factors: [], notes: [] };
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
    return fallback;
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
