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
import { FindingCard, type ReviewWorkflowFinding } from "./finding-card";
import { bulkDisableHighConfidence } from "./actions";

export type ReviewFilter =
  | "disable-ready"
  | "review"
  | "keep"
  | "disabled"
  | "acknowledged"
  | "failed"
  | "all";

const FILTER_LABELS: Record<ReviewFilter, string> = {
  "disable-ready": "Disable-ready",
  review: "Review",
  keep: "Keep",
  disabled: "Disabled",
  acknowledged: "Acknowledged",
  failed: "Failed",
  all: "All",
};

export function ReviewDashboard({
  auditId,
  totalWorkflows,
  findings,
  counts,
  bulkEligible,
  filter,
  page,
  pageSize,
  filteredTotal,
}: {
  auditId: string;
  totalWorkflows: number;
  findings: ReviewWorkflowFinding[];
  counts: {
    total: number;
    disableReady: number;
    review: number;
    keep: number;
    disabled: number;
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

  const handleBulkDisable = () => {
    setBulkError(null);
    startTransition(async () => {
      const result = await bulkDisableHighConfidence(auditId, 0.95);
      if (!result.ok) setBulkError(result.error ?? "Unknown error");
      else router.refresh();
    });
  };

  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));

  return (
    <div>
      <section className="mb-6">
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          Review: Workflows
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          {counts.total.toLocaleString()} findings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Scanned {totalWorkflows.toLocaleString()} workflows
        </p>
      </section>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Disable-ready" value={counts.disableReady} tone="orange" />
        <KpiCard label="Review" value={counts.review} tone="amber" />
        <KpiCard label="Disabled" value={counts.disabled} />
        <KpiCard label="Acknowledged" value={counts.acknowledged} />
        <KpiCard label="Failed" value={counts.failed} tone={counts.failed > 0 ? "red" : "neutral"} />
      </section>

      <section className="mb-6 flex flex-wrap items-center gap-2">
        {(Object.keys(FILTER_LABELS) as ReviewFilter[]).map((f) => {
          const label = FILTER_LABELS[f];
          const count =
            f === "disable-ready"
              ? counts.disableReady
              : f === "review"
                ? counts.review
                : f === "keep"
                  ? counts.keep
                  : f === "disabled"
                    ? counts.disabled
                    : f === "acknowledged"
                      ? counts.acknowledged
                      : f === "failed"
                        ? counts.failed
                        : counts.total;
          const active = f === filter;
          return (
            <Link
              key={f}
              href={`/cleanup/workflows/${auditId}?filter=${f}&page=1`}
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
                  Disable all high-confidence ({bulkEligible.toLocaleString()})
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Disable {bulkEligible} workflows?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>Reversible.</strong> Each workflow is re-fetched right
                  before disabling and re-scored; any that no longer recommend
                  disable are marked stale and skipped. Only findings scoring
                  ≥0.95 are processed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleBulkDisable}>
                  Disable all
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
                href={`/cleanup/workflows/${auditId}?filter=${filter}&page=${page - 1}`}
                className="hover:bg-accent rounded border px-3 py-1.5"
              >
                ← Prev
              </Link>
            )}
            {page < pageCount && (
              <Link
                href={`/cleanup/workflows/${auditId}?filter=${filter}&page=${page + 1}`}
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
  tone?: "emerald" | "amber" | "orange" | "red" | "neutral";
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "orange"
          ? "text-orange-600"
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
