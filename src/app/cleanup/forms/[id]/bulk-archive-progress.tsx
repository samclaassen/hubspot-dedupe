"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Progress } from "@/components/ui/progress";

type BulkStatus = {
  bulkArchiveStatus: string | null;
  bulkArchiveTotal: number | null;
  bulkArchivedCount: number;
  bulkArchiveFailedCount: number;
  bulkArchiveStartedAt: string | null;
  bulkArchiveCompletedAt: string | null;
  bulkArchiveError: string | null;
};

export function BulkArchiveProgress({
  auditId,
  initial,
}: {
  auditId: string;
  initial: BulkStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<BulkStatus>(initial);

  useEffect(() => {
    if (status.bulkArchiveStatus !== "running") return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/cleanup/forms/${auditId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as BulkStatus;
        setStatus(next);
        if (next.bulkArchiveStatus === "complete" || next.bulkArchiveStatus === "failed") {
          router.refresh();
        }
      } catch {
        // retry
      }
    };
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [auditId, status.bulkArchiveStatus, router]);

  if (!status.bulkArchiveStatus || status.bulkArchiveStatus === "complete") return null;

  const total = status.bulkArchiveTotal ?? 0;
  const done = status.bulkArchivedCount + status.bulkArchiveFailedCount;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (status.bulkArchiveStatus === "failed") {
    return (
      <div className="border-destructive/50 bg-destructive/5 mb-6 rounded-lg border p-4">
        <div className="text-destructive text-sm font-medium">Bulk archive failed</div>
        {status.bulkArchiveError && (
          <pre className="text-destructive mt-2 overflow-auto text-xs whitespace-pre-wrap">
            {status.bulkArchiveError}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="bg-muted mb-6 rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <div className="font-medium">Bulk archive running…</div>
        <div className="text-muted-foreground tabular-nums">
          {status.bulkArchivedCount.toLocaleString()} archived
          {status.bulkArchiveFailedCount > 0
            ? ` · ${status.bulkArchiveFailedCount} failed`
            : ""}
          {" / "}
          {total.toLocaleString()}
        </div>
      </div>
      <Progress value={pct} />
    </div>
  );
}
