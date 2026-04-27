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
import { FindingCard, type ReviewListFinding } from "./finding-card";
import { bulkDeleteHighConfidence } from "./actions";

export type ReviewFilter =
  | "delete-ready"
  | "review"
  | "keep"
  | "deleted"
  | "acknowledged"
  | "failed"
  | "all";

const FILTER_LABELS: Record<ReviewFilter, string> = {
  "delete-ready": "Delete-ready",
  review: "Review",
  keep: "Keep",
  deleted: "Deleted",
  acknowledged: "Acknowledged",
  failed: "Failed",
  all: "All",
};

export function ReviewDashboard({
  auditId,
  totalLists,
  findings,
  counts,
  bulkEligible,
  filter,
  page,
  pageSize,
  filteredTotal,
}: {
  auditId: string;
  totalLists: number;
  findings: ReviewListFinding[];
  counts: {
    total: number;
    deleteReady: number;
    review: number;
    keep: number;
    deleted: number;
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

  const handleBulkDelete = () => {
    setBulkError(null);
    startTransition(async () => {
      const result = await bulkDeleteHighConfidence(auditId, 0.95);
      if (!result.ok) setBulkError(result.error ?? "Unknown error");
      else router.refresh();
    });
  };

  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));

  return (
    <div>
      <section className="mb-6">
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          Review: Lists
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          {counts.total.toLocaleString()} findings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Scanned {totalLists.toLocaleString()} lists
        </p>
      </section>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Delete-ready" value={counts.deleteReady} tone="red" />
        <KpiCard label="Review" value={counts.review} tone="amber" />
        <KpiCard label="Deleted" value={counts.deleted} />
        <KpiCard label="Acknowledged" value={counts.acknowledged} />
        <KpiCard label="Failed" value={counts.failed} tone={counts.failed > 0 ? "red" : "neutral"} />
      </section>

      <section className="mb-6 flex flex-wrap items-center gap-2">
        {(Object.keys(FILTER_LABELS) as ReviewFilter[]).map((f) => {
          const label = FILTER_LABELS[f];
          const count =
            f === "delete-ready"
              ? counts.deleteReady
              : f === "review"
                ? counts.review
                : f === "keep"
                  ? counts.keep
                  : f === "deleted"
                    ? counts.deleted
                    : f === "acknowledged"
                      ? counts.acknowledged
                      : f === "failed"
                        ? counts.failed
                        : counts.total;
          const active = f === filter;
          return (
            <Link
              key={f}
              href={`/cleanup/lists/${auditId}?filter=${f}&page=1`}
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
                <Button variant="destructive" disabled={pending} size="sm">
                  Delete all high-confidence ({bulkEligible.toLocaleString()})
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {bulkEligible} lists?</AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>Hard delete — no recovery.</strong> Each list is
                  re-checked for references right before deleting. Any list
                  that now has ≥1 workflow/report reference is skipped
                  (marked &ldquo;stale&rdquo;). Only findings scoring ≥0.95 are
                  processed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleBulkDelete}>
                  Delete all
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
                href={`/cleanup/lists/${auditId}?filter=${filter}&page=${page - 1}`}
                className="hover:bg-accent rounded border px-3 py-1.5"
              >
                ← Prev
              </Link>
            )}
            {page < pageCount && (
              <Link
                href={`/cleanup/lists/${auditId}?filter=${filter}&page=${page + 1}`}
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
