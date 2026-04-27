"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

type AuditStatus = {
  status: string;
  stage: string | null;
  propertiesScanned: number;
  totalProperties: number | null;
  findingsCount: number;
  error: string | null;
};

const STAGE_LABELS: Record<string, string> = {
  loading_properties: "Loading HubSpot property metadata…",
  counting: "Counting populated records per property…",
  loading_workflows: "Scanning workflows for property references…",
  scoring: "Scoring properties…",
  persisting: "Saving findings…",
};

export function AuditProgress({
  auditId,
  initial,
}: {
  auditId: string;
  initial: AuditStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<AuditStatus>(initial);

  useEffect(() => {
    if (status.status === "complete" || status.status === "failed") return;

    const tick = async () => {
      try {
        const res = await fetch(`/api/cleanup/properties/${auditId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as AuditStatus;
        setStatus(next);
        if (next.status === "complete") router.refresh();
      } catch {
        // Silent retry.
      }
    };

    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [auditId, status.status, router]);

  const pct =
    status.totalProperties && status.totalProperties > 0
      ? Math.min(
          100,
          Math.round((status.propertiesScanned / status.totalProperties) * 100)
        )
      : 0;

  if (status.status === "failed") {
    return (
      <Card className="border-destructive/50">
        <CardHeader>
          <Badge variant="destructive" className="w-fit">
            Failed
          </Badge>
          <CardTitle className="mt-2">Audit failed</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted text-destructive overflow-auto rounded p-3 text-xs whitespace-pre-wrap">
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
          {status.totalProperties
            ? `${status.propertiesScanned.toLocaleString()} of ${status.totalProperties.toLocaleString()} properties`
            : "Loading property list…"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Progress value={pct} />
        <div className="text-muted-foreground mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide">
              Properties scanned
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {status.propertiesScanned.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide">
              Findings so far
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {status.findingsCount.toLocaleString()}
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mt-6 text-xs">
          This takes 3–8 minutes depending on property + workflow counts.
          Progress is saved — you can come back any time.
        </p>
      </CardContent>
    </Card>
  );
}
