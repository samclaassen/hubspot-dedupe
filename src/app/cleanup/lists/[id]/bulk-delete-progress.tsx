"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Progress } from "@/components/ui/progress";

type BulkStatus = {
  bulkDeleteStatus: string | null;
  bulkDeleteTotal: number | null;
  bulkDeletedCount: number;
  bulkDeleteFailedCount: number;
  bulkDeleteStartedAt: string | null;
  bulkDeleteCompletedAt: string | null;
  bulkDeleteError: string | null;
};

export function BulkDeleteProgress({
  auditId,
  initial,
}: {
  auditId: string;
  initial: BulkStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<BulkStatus>(initial);

  useEffect(() => {
    if (status.bulkDeleteStatus !== "running") return;

    const tick = async () => {
      try {
        const res = await fetch(`/api/cleanup/lists/${auditId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as BulkStatus;
        setStatus(next);
        if (next.bulkDeleteStatus === "complete" || next.bulkDeleteStatus === "failed") {
          router.refresh();
        }
      } catch {
        // retry
      }
    };

    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [auditId, status.bulkDeleteStatus, router]);

  if (!status.bulkDeleteStatus || status.bulkDeleteStatus === "complete") {
    return null;
  }

  const total = status.bulkDeleteTotal ?? 0;
  const done = status.bulkDeletedCount + status.bulkDeleteFailedCount;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (status.bulkDeleteStatus === "failed") {
    return (
      <div className="border-destructive/50 bg-destructive/5 mb-6 rounded-lg border p-4">
        <div className="text-destructive text-sm font-medium">
          Bulk delete failed
        </div>
        {status.bulkDeleteError && (
          <pre className="text-destructive mt-2 overflow-auto text-xs whitespace-pre-wrap">
            {status.bulkDeleteError}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="bg-muted mb-6 rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <div className="font-medium">Bulk delete running…</div>
        <div className="text-muted-foreground tabular-nums">
          {status.bulkDeletedCount.toLocaleString()} deleted
          {status.bulkDeleteFailedCount > 0
            ? ` · ${status.bulkDeleteFailedCount} failed`
            : ""}
          {" / "}
          {total.toLocaleString()}
        </div>
      </div>
      <Progress value={pct} />
    </div>
  );
}
