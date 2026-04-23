"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

type AutoMergeStatus = {
  autoMergeStatus: string | null;
  autoMergeTotal: number | null;
  autoMergedCount: number;
  autoMergeFailedCount: number;
  autoMergeStartedAt: string | null;
  autoMergeCompletedAt: string | null;
  autoMergeError: string | null;
  counts?: { pending: number; merged: number; failed: number };
};

export function AutoMergeProgress({
  scanId,
  initial,
}: {
  scanId: string;
  initial: AutoMergeStatus;
}) {
  const router = useRouter();
  const [state, setState] = useState<AutoMergeStatus>(initial);

  useEffect(() => {
    // Only poll while running
    if (state.autoMergeStatus !== "running") return;

    const tick = async () => {
      try {
        const res = await fetch(`/api/scan/${scanId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as AutoMergeStatus;
        setState(next);
        if (next.autoMergeStatus === "complete" || next.autoMergeStatus === "failed") {
          // Refresh server components so the KPI cards + counts update
          router.refresh();
        }
      } catch {
        // swallow — next tick will try again
      }
    };

    const id = setInterval(tick, 2000);
    // Immediate first tick
    void tick();
    return () => clearInterval(id);
  }, [scanId, state.autoMergeStatus, router]);

  if (!state.autoMergeStatus) return null;

  const total = state.autoMergeTotal ?? 0;
  const processed = state.autoMergedCount + state.autoMergeFailedCount;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  if (state.autoMergeStatus === "running") {
    return (
      <Card className="mb-4 border-blue-300 bg-blue-50">
        <CardContent className="py-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge className="bg-blue-600">Auto-merging…</Badge>
              <span className="text-sm font-medium">
                {processed.toLocaleString()} of {total.toLocaleString()} groups
              </span>
            </div>
            <div className="text-muted-foreground text-xs">
              {state.autoMergedCount.toLocaleString()} merged ·{" "}
              {state.autoMergeFailedCount.toLocaleString()} failed
            </div>
          </div>
          <Progress value={pct} className="h-2" />
          <p className="text-muted-foreground mt-2 text-xs">
            Running in the background. You can navigate away — the queue will
            keep processing. Come back any time to see progress.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (state.autoMergeStatus === "complete") {
    return (
      <Card className="mb-4 border-emerald-300 bg-emerald-50">
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge className="bg-emerald-600">Auto-merge complete</Badge>
              <span className="text-sm font-medium">
                {state.autoMergedCount.toLocaleString()} merged ·{" "}
                {state.autoMergeFailedCount.toLocaleString()} failed
              </span>
            </div>
            {state.autoMergeCompletedAt && (
              <div className="text-muted-foreground text-xs">
                Finished {new Date(state.autoMergeCompletedAt).toLocaleString()}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state.autoMergeStatus === "failed") {
    return (
      <Card className="border-destructive/50 mb-4">
        <CardContent className="py-4">
          <Badge variant="destructive">Auto-merge failed</Badge>
          <pre className="text-destructive mt-2 overflow-auto text-xs whitespace-pre-wrap">
            {state.autoMergeError ?? "Unknown error"}
          </pre>
        </CardContent>
      </Card>
    );
  }

  return null;
}
