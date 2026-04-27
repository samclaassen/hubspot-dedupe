import Link from "next/link";
import { getContactsTotal, getCompaniesTotal } from "@/lib/hubspot";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  computeHygieneScore,
  scoreColor,
  scoreBarColor,
  scoreLabel,
  type CategoryScore,
} from "@/lib/hygiene-score";

// Force server-rendering on every request so the hygiene score + past audits
// reflect the live DB state (otherwise Next prerenders at build time and we
// ship stale data to users).
export const dynamic = "force-dynamic";

export default async function Home() {
  // Fetch live totals + scan runs + latest scheduled run + latest cleanup audits in parallel
  const [
    contactsTotal,
    companiesTotal,
    scans,
    latestScheduled,
    latestCompletedScan,
    lastPropertyAudit,
    lastListAudit,
    lastWorkflowAudit,
    lastFormAudit,
  ] = await Promise.all([
    getContactsTotal().catch((e: Error) => ({ error: e.message })),
    getCompaniesTotal().catch((e: Error) => ({ error: e.message })),
    db.scanRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
      include: { _count: { select: { groups: true } } },
    }),
    // Scans created by scripts/weekly-dedupe.ts tag their ruleSet with
    // "scheduled":true. Grab the most recent one for the dashboard widget.
    db.scanRun.findFirst({
      where: { ruleSet: { contains: '"scheduled":true' } },
      orderBy: { startedAt: "desc" },
    }),
    // Most recent COMPLETE scan (scheduled or manual) — used for hygiene score
    db.scanRun.findFirst({
      where: { status: "complete" },
      orderBy: { startedAt: "desc" },
    }),
    db.propertyAuditRun.findFirst({
      where: { status: "complete" },
      orderBy: { startedAt: "desc" },
    }),
    db.listAuditRun.findFirst({
      where: { status: "complete" },
      orderBy: { startedAt: "desc" },
    }),
    db.workflowAuditRun.findFirst({
      where: { status: "complete" },
      orderBy: { startedAt: "desc" },
    }),
    db.formAuditRun.findFirst({
      where: { status: "complete" },
      orderBy: { startedAt: "desc" },
    }),
  ]);

  // Load per-recommendation counts for the 3 latest cleanup audits.
  // Each set runs in parallel; total 9 small queries.
  const [
    propertyArchiveReady,
    propertyReview,
    propertyKeep,
    listDeleteReady,
    listReview,
    listKeep,
    workflowDisableReady,
    workflowReview,
    workflowKeep,
    formArchiveReady,
    formReview,
    formKeep,
  ] = await Promise.all([
    lastPropertyAudit
      ? db.propertyFinding.count({
          where: { auditRunId: lastPropertyAudit.id, status: "pending", recommendation: "archive" },
        })
      : Promise.resolve(0),
    lastPropertyAudit
      ? db.propertyFinding.count({
          where: { auditRunId: lastPropertyAudit.id, status: "pending", recommendation: "review" },
        })
      : Promise.resolve(0),
    lastPropertyAudit
      ? db.propertyFinding.count({
          where: { auditRunId: lastPropertyAudit.id, status: "pending", recommendation: "keep" },
        })
      : Promise.resolve(0),
    lastListAudit
      ? db.listFinding.count({
          where: { auditRunId: lastListAudit.id, status: "pending", recommendation: "delete" },
        })
      : Promise.resolve(0),
    lastListAudit
      ? db.listFinding.count({
          where: { auditRunId: lastListAudit.id, status: "pending", recommendation: "review" },
        })
      : Promise.resolve(0),
    lastListAudit
      ? db.listFinding.count({
          where: { auditRunId: lastListAudit.id, status: "pending", recommendation: "keep" },
        })
      : Promise.resolve(0),
    lastWorkflowAudit
      ? db.workflowFinding.count({
          where: { auditRunId: lastWorkflowAudit.id, status: "pending", recommendation: "disable" },
        })
      : Promise.resolve(0),
    lastWorkflowAudit
      ? db.workflowFinding.count({
          where: { auditRunId: lastWorkflowAudit.id, status: "pending", recommendation: "review" },
        })
      : Promise.resolve(0),
    lastWorkflowAudit
      ? db.workflowFinding.count({
          where: { auditRunId: lastWorkflowAudit.id, status: "pending", recommendation: "keep" },
        })
      : Promise.resolve(0),
    lastFormAudit
      ? db.formFinding.count({
          where: { auditRunId: lastFormAudit.id, status: "pending", recommendation: "archive" },
        })
      : Promise.resolve(0),
    lastFormAudit
      ? db.formFinding.count({
          where: { auditRunId: lastFormAudit.id, status: "pending", recommendation: "review" },
        })
      : Promise.resolve(0),
    lastFormAudit
      ? db.formFinding.count({
          where: { auditRunId: lastFormAudit.id, status: "pending", recommendation: "keep" },
        })
      : Promise.resolve(0),
  ]);

  const hygiene = computeHygieneScore({
    dedupe: latestCompletedScan
      ? {
          groupsFound: latestCompletedScan.groupsFound,
          recordsScanned: latestCompletedScan.recordsScanned,
          scanId: latestCompletedScan.id,
          autoMerged: latestCompletedScan.autoMergedCount,
        }
      : null,
    properties: lastPropertyAudit
      ? {
          auditId: lastPropertyAudit.id,
          totalProperties: lastPropertyAudit.totalProperties ?? 0,
          archiveReady: propertyArchiveReady,
          review: propertyReview,
          keep: propertyKeep,
        }
      : null,
    lists: lastListAudit
      ? {
          auditId: lastListAudit.id,
          totalLists: lastListAudit.totalLists ?? 0,
          deleteReady: listDeleteReady,
          review: listReview,
          keep: listKeep,
        }
      : null,
    workflows: lastWorkflowAudit
      ? {
          auditId: lastWorkflowAudit.id,
          totalWorkflows: lastWorkflowAudit.totalWorkflows ?? 0,
          disableReady: workflowDisableReady,
          review: workflowReview,
          keep: workflowKeep,
        }
      : null,
    forms: lastFormAudit
      ? {
          auditId: lastFormAudit.id,
          totalForms: lastFormAudit.totalForms ?? 0,
          archiveReady: formArchiveReady,
          review: formReview,
          keep: formKeep,
        }
      : null,
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">HubSpot Cleanup</h1>
          <p className="text-muted-foreground mt-1">
            Find duplicates, unused properties, and stale lists
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/cleanup"
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
          >
            Cleanup audits
          </Link>
          <Link
            href="/scan/new"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
          >
            + New Scan
          </Link>
        </div>
      </header>

      <HygieneScoreSection result={hygiene} />

      <section className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Contacts in HubSpot</CardDescription>
            <CardTitle className="text-4xl">
              {typeof contactsTotal === "number"
                ? contactsTotal.toLocaleString()
                : <span className="text-base text-destructive">Auth failed</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {typeof contactsTotal === "number" ? (
              <p className="text-muted-foreground text-sm">
                Ready to scan. Connected via Private App token.
              </p>
            ) : (
              <pre className="text-destructive text-xs whitespace-pre-wrap">
                {contactsTotal.error}
              </pre>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Companies in HubSpot</CardDescription>
            <CardTitle className="text-4xl">
              {typeof companiesTotal === "number"
                ? companiesTotal.toLocaleString()
                : <span className="text-base text-destructive">Auth failed</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {typeof companiesTotal === "number" ? (
              <p className="text-muted-foreground text-sm">Ready to scan.</p>
            ) : (
              <pre className="text-destructive text-xs whitespace-pre-wrap">
                {companiesTotal.error}
              </pre>
            )}
          </CardContent>
        </Card>
      </section>

      {latestScheduled && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Scheduled weekly run</h2>
          <Link
            href={`/scan/${latestScheduled.id}`}
            className="hover:bg-accent flex items-center justify-between rounded-md border-2 border-dashed p-4 transition-colors"
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={latestScheduled.status} />
              <div>
                <div className="font-medium">Last scheduled dedupe</div>
                <div className="text-muted-foreground text-xs">
                  {latestScheduled.startedAt.toLocaleString()}
                  {latestScheduled.autoMergeStatus === "complete"
                    ? " · auto-merge complete"
                    : latestScheduled.autoMergeStatus === "running"
                    ? " · auto-merge running…"
                    : ""}
                </div>
              </div>
            </div>
            <div className="text-muted-foreground text-right text-sm">
              <div>
                {latestScheduled.autoMergedCount.toLocaleString()} merged
                {latestScheduled.autoMergeFailedCount > 0
                  ? ` · ${latestScheduled.autoMergeFailedCount} failed`
                  : ""}
              </div>
              <div>{latestScheduled.groupsFound} duplicate groups</div>
            </div>
          </Link>
          <p className="text-muted-foreground mt-2 text-xs">
            Runs every Sunday at 2:00 AM via launchd on the Mac Mini.
          </p>
        </section>
      )}

      {(lastPropertyAudit || lastListAudit || lastWorkflowAudit) && (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Latest cleanup audits</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {lastPropertyAudit && (
              <Link
                href={`/cleanup/properties/${lastPropertyAudit.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={lastPropertyAudit.status} />
                  <div>
                    <div className="font-medium">Property audit</div>
                    <div className="text-muted-foreground text-xs">
                      {lastPropertyAudit.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>{lastPropertyAudit.findingsCount.toLocaleString()} findings</div>
                  <div>
                    {lastPropertyAudit.propertiesScanned.toLocaleString()} scanned
                  </div>
                </div>
              </Link>
            )}
            {lastListAudit && (
              <Link
                href={`/cleanup/lists/${lastListAudit.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={lastListAudit.status} />
                  <div>
                    <div className="font-medium">List audit</div>
                    <div className="text-muted-foreground text-xs">
                      {lastListAudit.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>{lastListAudit.findingsCount.toLocaleString()} findings</div>
                  <div>
                    {lastListAudit.listsScanned.toLocaleString()} scanned
                  </div>
                </div>
              </Link>
            )}
            {lastWorkflowAudit && (
              <Link
                href={`/cleanup/workflows/${lastWorkflowAudit.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={lastWorkflowAudit.status} />
                  <div>
                    <div className="font-medium">Workflow audit</div>
                    <div className="text-muted-foreground text-xs">
                      {lastWorkflowAudit.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>{lastWorkflowAudit.findingsCount.toLocaleString()} findings</div>
                  <div>
                    {lastWorkflowAudit.workflowsScanned.toLocaleString()} scanned
                  </div>
                </div>
              </Link>
            )}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Past scans</h2>
        {scans.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center">
              No scans yet. Start one to find duplicates.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {scans.map((s) => (
              <Link
                key={s.id}
                href={`/scan/${s.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <div>
                    <div className="font-medium capitalize">
                      {s.objectType}s scan
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {s.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>
                    {s.recordsScanned.toLocaleString()}
                    {s.totalRecords ? ` / ${s.totalRecords.toLocaleString()}` : ""} records
                  </div>
                  <div>{s._count.groups} duplicate groups</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "outline",
    running: "secondary",
    complete: "default",
    failed: "destructive",
  };
  return <Badge variant={variants[status] ?? "outline"}>{status}</Badge>;
}

function HygieneScoreSection({
  result,
}: {
  result: ReturnType<typeof computeHygieneScore>;
}) {
  return (
    <section className="mb-10">
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[auto_1fr] md:gap-12">
            <div className="flex flex-col justify-center md:min-w-56">
              <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Portal Hygiene Score
              </div>
              {result.overall !== null ? (
                <>
                  <div
                    className={`mt-1 text-6xl font-bold tabular-nums ${scoreColor(result.overall)}`}
                  >
                    {result.overall}
                    <span className="text-muted-foreground text-2xl font-medium">
                      {" / 100"}
                    </span>
                  </div>
                  <div
                    className={`mt-1 text-sm font-medium ${scoreColor(result.overall)}`}
                  >
                    {scoreLabel(result.overall)}
                  </div>
                  <div className="text-muted-foreground mt-2 text-xs">
                    Average across {result.measuredCount} measured{" "}
                    {result.measuredCount === 1 ? "category" : "categories"}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-muted-foreground mt-1 text-4xl font-bold">
                    —
                  </div>
                  <div className="text-muted-foreground mt-2 text-sm">
                    Run an audit in any category to see your score
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col justify-center gap-3">
              {result.categories.map((c) => (
                <CategoryScoreRow key={c.label} category={c} />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function CategoryScoreRow({ category }: { category: CategoryScore }) {
  const commonWrapper =
    "flex items-center gap-4 rounded-md p-2 -m-2 transition-colors";
  const labelCell = "min-w-40 text-sm font-medium";
  const barCell = "flex-1 flex items-center gap-3";

  if (!category.measured) {
    const inner = (
      <>
        <div className={labelCell}>
          <div>{category.label}</div>
          <div className="text-muted-foreground text-xs">{category.summary}</div>
        </div>
        <div className={barCell}>
          <div className="bg-muted h-2 flex-1 rounded-full" />
          <div className="text-muted-foreground min-w-20 text-right text-xs">
            {category.detail}
          </div>
        </div>
      </>
    );
    return category.auditUrl ? (
      <Link href={category.auditUrl} className={`${commonWrapper} hover:bg-accent`}>
        {inner}
      </Link>
    ) : (
      <div className={commonWrapper}>{inner}</div>
    );
  }

  const barWidth = Math.max(2, Math.min(100, category.score));
  const scoreClass = scoreColor(category.score);
  const barClass = scoreBarColor(category.score);

  const inner = (
    <>
      <div className={labelCell}>
        <div>{category.label}</div>
        <div className="text-muted-foreground text-xs">{category.summary}</div>
      </div>
      <div className={barCell}>
        <div className="bg-muted relative h-2 flex-1 overflow-hidden rounded-full">
          <div
            className={`absolute inset-y-0 left-0 ${barClass} rounded-full transition-all`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <div className="min-w-24 text-right">
          <div className={`text-sm font-semibold tabular-nums ${scoreClass}`}>
            {category.score}
          </div>
          <div className="text-muted-foreground text-xs">{category.detail}</div>
        </div>
      </div>
    </>
  );

  return category.auditUrl ? (
    <Link href={category.auditUrl} className={`${commonWrapper} hover:bg-accent`}>
      {inner}
    </Link>
  ) : (
    <div className={commonWrapper}>{inner}</div>
  );
}
