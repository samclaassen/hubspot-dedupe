"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FindingCard, type ReviewFinding } from "./finding-card";
import { bulkArchiveHighConfidence } from "./actions";

export type ReviewFilter =
  | "archive-ready"
  | "review"
  | "keep"
  | "archived"
  | "acknowledged"
  | "failed"
  | "all";

const FILTER_LABELS: Record<ReviewFilter, string> = {
  "archive-ready": "Archive-ready",
  review: "Review",
  keep: "Keep",
  archived: "Archived",
  acknowledged: "Acknowledged",
  failed: "Failed",
  all: "All",
};

export function ReviewDashboard({
  auditId,
  objectTypes,
  totalProperties,
  findings,
  counts,
  bulkEligible,
  filter,
  page,
  pageSize,
  filteredTotal,
}: {
  auditId: string;
  objectTypes: string[];
  totalProperties: number;
  findings: ReviewFinding[];
  counts: {
    total: number;
    archiveReady: number;
    review: number;
    keep: number;
    archived: number;
    acknowledged: number;
    failed: number;
  };
  bulkEligible: number;
  filter: ReviewFilter;
  page: number;
  pageSize: number;
  filteredTotal: number;
}) {
  const [pending, startTransition] = useTransition();
  const [bulkError, setBulkError] = useState<string | null>(null);
  const router = useRouter();

  const handleBulkArchive = () => {
    setBulkError(null);
    startTransition(async () => {
      const result = await bulkArchiveHighConfidence(auditId, 0.95);
      if (!result.ok) setBulkError(result.error ?? "Unknown error");
      else router.refresh();
    });
  };

  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));

  return (
    <div>
      <section className="mb-6">
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          Review: {objectTypes.join(" · ")} properties
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          {counts.total.toLocaleString()} findings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Scanned {totalProperties.toLocaleString()} properties
        </p>
      </section>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Archive-ready" value={counts.archiveReady} tone="emerald" />
        <KpiCard label="Review" value={counts.review} tone="amber" />
        <KpiCard label="Archived" value={counts.archived} />
        <KpiCard label="Acknowledged" value={counts.acknowledged} />
        <KpiCard label="Failed" value={counts.failed} tone={counts.failed > 0 ? "red" : "neutral"} />
      </section>

      <section className="mb-6 flex flex-wrap items-center gap-2">
        {(Object.keys(FILTER_LABELS) as ReviewFilter[]).map((f) => {
          const label = FILTER_LABELS[f];
          const count =
            f === "archive-ready"
              ? counts.archiveReady
              : f === "review"
                ? counts.review
                : f === "keep"
                  ? counts.keep
                  : f === "archived"
                    ? counts.archived
                    : f === "acknowledged"
                      ? counts.acknowledged
                      : f === "failed"
                        ? counts.failed
                        : counts.total;
          const active = f === filter;
          return (
            <Link
              key={f}
              href={`/cleanup/properties/${auditId}?filter=${f}&page=1`}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-foreground text-background border-foreground"
                  : "hover:bg-accent"
              }`}
            >
              {label} ({count.toLocaleString()})
            </Link>
          );
        })}

        <div className="flex-1" />

        {bulkEligible > 0 && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="default" disabled={pending} size="sm">
                  Archive all high-confidence ({bulkEligible.toLocaleString()})
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Archive {bulkEligible} properties?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This archives every &quot;archive-ready&quot; finding scoring
                  ≥0.95. HubSpot archives are soft (90-day recovery). Any
                  property that now has a workflow reference or is no longer
                  archivable will be marked &quot;stale&quot; and skipped.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleBulkArchive}>
                  Archive all
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </section>

      {bulkError && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded p-3 text-sm">
          {bulkError}
        </div>
      )}

      <section className="space-y-2">
        {findings.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center">
              No findings match this filter.
            </CardContent>
          </Card>
        ) : (
          findings.map((f) => <FindingCard key={f.id} finding={f} />)
        )}
      </section>

      {pageCount > 1 && (
        <nav className="text-muted-foreground mt-6 flex items-center justify-between text-sm">
          <div>
            Page {page} of {pageCount} · Showing {findings.length} of{" "}
            {filteredTotal.toLocaleString()}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/cleanup/properties/${auditId}?filter=${filter}&page=${page - 1}`}
                className="hover:bg-accent rounded border px-3 py-1.5"
              >
                ← Prev
              </Link>
            )}
            {page < pageCount && (
              <Link
                href={`/cleanup/properties/${auditId}?filter=${filter}&page=${page + 1}`}
                className="hover:bg-accent rounded border px-3 py-1.5"
              >
                Next →
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber" | "red" | "neutral";
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "red"
          ? "text-destructive"
          : "";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`text-3xl ${valueClass}`}>
          {value.toLocaleString()}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
