"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { GroupCard } from "./group-card";
import { skipAllPending, autoMergePending } from "./actions";

export type ReviewGroup = {
  id: string;
  matchTier: string;
  matchScore: number;
  matchReasons: Record<string, string>;
  status: string;
  primaryId: string | null;
  errorMessage: string | null;
  members: Array<{
    id: string;
    hubspotId: string;
    propertiesSnapshot: Record<string, string | null>;
  }>;
};

type StatusFilter = "pending" | "merged" | "skipped" | "failed" | "all";
type StatusCounts = {
  pending: number;
  merged: number;
  skipped: number;
  failed: number;
};

export function ReviewDashboard({
  scanId,
  objectType,
  recordsScanned,
  totalRecords,
  counts,
  totalGroups,
  filter,
  page,
  pageSize,
  filteredTotal,
  autoMergeEligible,
  groups,
}: {
  scanId: string;
  objectType: string;
  recordsScanned: number;
  totalRecords: number | null;
  counts: StatusCounts;
  totalGroups: number;
  filter: StatusFilter;
  page: number;
  pageSize: number;
  filteredTotal: number;
  autoMergeEligible: number;
  groups: ReviewGroup[];
}) {
  const [bulkPending, startBulkTransition] = useTransition();
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const handleSkipAll = () => {
    setBulkResult(null);
    startBulkTransition(async () => {
      const r = await skipAllPending(scanId);
      setBulkResult(r.ok ? `Skipped ${r.skipped} groups` : `Failed: ${r.error}`);
    });
  };

  const handleAutoMerge = () => {
    setBulkResult(null);
    startBulkTransition(async () => {
      const r = await autoMergePending(scanId, 0.99);
      setBulkResult(
        r.ok
          ? `Auto-merge started on ${r.total} groups — see progress banner above`
          : `Failed: ${r.error}`
      );
      // The page will refresh automatically via the AutoMergeProgress component's
      // polling when the background task starts writing status updates.
    });
  };

  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const startItem = filteredTotal === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, filteredTotal);

  return (
    <div>
      <div className="mb-6">
        <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
          Review: {objectType}s
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          {totalGroups.toLocaleString()} duplicate groups
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Scanned {recordsScanned.toLocaleString()}
          {totalRecords ? ` of ${totalRecords.toLocaleString()}` : ""} records
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Total groups" value={totalGroups} tone="primary" />
        <Kpi label="Merged" value={counts.merged} tone="success" />
        <Kpi label="Skipped" value={counts.skipped} tone="muted" />
        <Kpi label="Pending" value={counts.pending} tone="warning" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border p-1">
          <FilterLink current={filter} value="pending" count={counts.pending} scanId={scanId} />
          <FilterLink current={filter} value="merged" count={counts.merged} scanId={scanId} />
          <FilterLink current={filter} value="skipped" count={counts.skipped} scanId={scanId} />
          {counts.failed > 0 && (
            <FilterLink current={filter} value="failed" count={counts.failed} scanId={scanId} />
          )}
          <FilterLink current={filter} value="all" count={totalGroups} scanId={scanId} />
        </div>
        <div className="flex gap-2">
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkPending || counts.pending === 0}
                >
                  Skip All ({counts.pending})
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Skip all {counts.pending} pending groups?</AlertDialogTitle>
                <AlertDialogDescription>
                  This marks all currently pending groups as skipped in the database.
                  It does NOT modify HubSpot. You can still re-scan later to revisit them.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleSkipAll}>Skip All</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  size="sm"
                  disabled={bulkPending || autoMergeEligible === 0}
                >
                  Auto-merge All ({autoMergeEligible})
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Auto-merge {autoMergeEligible} high-confidence groups?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>This cannot be undone.</strong> All groups with a match score
                  of 99% or higher will be merged in HubSpot. Each group uses the
                  most-complete record as the primary.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleAutoMerge}>
                  Merge {autoMergeEligible} groups
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {bulkResult && (
        <div className="bg-muted text-muted-foreground mb-3 rounded p-2 text-xs">
          {bulkResult}
        </div>
      )}

      {filteredTotal > 0 && (
        <div className="text-muted-foreground mb-3 text-xs">
          Showing {startItem}–{endItem} of {filteredTotal.toLocaleString()} groups
        </div>
      )}

      {groups.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center">
            {totalGroups === 0
              ? "No duplicate groups found."
              : `No groups in "${filter}" status.`}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <GroupCard key={g.id} scanId={scanId} group={g} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <div className="text-muted-foreground text-xs">
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/scan/${scanId}?filter=${filter}&page=${page - 1}`}
                className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
              >
                ← Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/scan/${scanId}?filter=${filter}&page=${page + 1}`}
                className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterLink({
  current,
  value,
  count,
  scanId,
}: {
  current: StatusFilter;
  value: StatusFilter;
  count: number;
  scanId: string;
}) {
  const active = current === value;
  return (
    <Link
      href={`/scan/${scanId}?filter=${value}`}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {value.charAt(0).toUpperCase() + value.slice(1)} ({count})
    </Link>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "primary" | "success" | "warning" | "muted";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-600"
      : tone === "warning"
      ? "text-amber-600"
      : tone === "primary"
      ? "text-foreground"
      : "text-muted-foreground";
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          {label}
        </div>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold tabular-nums ${toneClass}`}>
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}
