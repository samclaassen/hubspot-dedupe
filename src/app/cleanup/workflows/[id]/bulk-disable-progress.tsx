"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Progress } from "@/components/ui/progress";

type BulkStatus = {
  bulkDisableStatus: string | null;
  bulkDisableTotal: number | null;
  bulkDisabledCount: number;
  bulkDisableFailedCount: number;
  bulkDisableStartedAt: string | null;
  bulkDisableCompletedAt: string | null;
  bulkDisableError: string | null;
};

export function BulkDisableProgress({
  auditId,
  initial,
}: {
  auditId: string;
  initial: BulkStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<BulkStatus>(initial);

  useEffect(() => {
    if (status.bulkDisableStatus !== "running") return;

    const tick = async () => {
      try {
        const res = await fetch(`/api/cleanup/workflows/${auditId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as BulkStatus;
        setStatus(next);
        if (next.bulkDisableStatus === "complete" || next.bulkDisableStatus === "failed") {
          router.refresh();
        }
      } catch {
        // retry
      }
    };

    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [auditId, status.bulkDisableStatus, router]);

  if (!status.bulkDisableStatus || status.bulkDisableStatus === "complete") return null;

  const total = status.bulkDisableTotal ?? 0;
  const done = status.bulkDisabledCount + status.bulkDisableFailedCount;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (status.bulkDisableStatus === "failed") {
    return (
      <div className="border-destructive/50 bg-destructive/5 mb-6 rounded-lg border p-4">
        <div className="text-destructive text-sm font-medium">
          Bulk disable failed
        </div>
        {status.bulkDisableError && (
          <pre className="text-destructive mt-2 overflow-auto text-xs whitespace-pre-wrap">
            {status.bulkDisableError}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="bg-muted mb-6 rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <div className="font-medium">Bulk disable running…</div>
        <div className="text-muted-foreground tabular-nums">
          {status.bulkDisabledCount.toLocaleString()} disabled
          {status.bulkDisableFailedCount > 0
            ? ` · ${status.bulkDisableFailedCount} failed`
            : ""}
          {" / "}
          {total.toLocaleString()}
        </div>
      </div>
      <Progress value={pct} />
    </div>
  );
}
