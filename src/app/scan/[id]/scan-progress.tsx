"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

type ScanStatus = {
  status: string;
  stage: string | null;
  recordsScanned: number;
  totalRecords: number | null;
  groupsFound: number;
  error: string | null;
};

const STAGE_LABELS: Record<string, string> = {
  counting: "Counting records…",
  paginating: "Reading contacts from HubSpot…",
  matching: "Detecting duplicates…",
  persisting: "Saving duplicate groups…",
};

export function ScanProgress({
  scanId,
  initial,
}: {
  scanId: string;
  initial: ScanStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ScanStatus>(initial);

  useEffect(() => {
    if (status.status === "complete" || status.status === "failed") return;

    const tick = async () => {
      try {
        const res = await fetch(`/api/scan/${scanId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as ScanStatus;
        setStatus(next);
        if (next.status === "complete") {
          // Switch to review view
          router.refresh();
        }
      } catch {
        // Silent retry — next tick will try again
      }
    };

    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [scanId, status.status, router]);

  const pct =
    status.totalRecords && status.totalRecords > 0
      ? Math.min(100, Math.round((status.recordsScanned / status.totalRecords) * 100))
      : 0;

  if (status.status === "failed") {
    return (
      <Card className="border-destructive/50">
        <CardHeader>
          <Badge variant="destructive" className="w-fit">Failed</Badge>
          <CardTitle className="mt-2">Scan failed</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted text-destructive overflow-auto rounded p-3 text-xs">
            {status.error ?? "Unknown error"}
          </pre>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <Badge variant="secondary" className="w-fit">
          {status.status === "queued" ? "Queued" : "Running"}
        </Badge>
        <CardTitle className="mt-2">
          {STAGE_LABELS[status.stage ?? ""] ?? "Starting…"}
        </CardTitle>
        <CardDescription>
          {status.totalRecords
            ? `${status.recordsScanned.toLocaleString()} of ${status.totalRecords.toLocaleString()} records`
            : "Counting…"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Progress value={pct} />
        <div className="text-muted-foreground mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide">Records scanned</div>
            <div className="text-2xl font-semibold tabular-nums">
              {status.recordsScanned.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide">Duplicate groups found</div>
            <div className="text-2xl font-semibold tabular-nums">
              {status.groupsFound.toLocaleString()}
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mt-6 text-xs">
          Scans take 1–3 minutes for a ~50k contact portal. Leave this page open
          or come back later — progress is saved.
        </p>
      </CardContent>
    </Card>
  );
}
