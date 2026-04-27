"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  acknowledgeProperty,
  archivePropertyFinding,
  suppressProperty,
} from "./actions";

export type ReviewFinding = {
  id: string;
  objectType: string;
  propertyName: string;
  propertyLabel: string;
  propertyGroupName: string | null;
  fieldType: string;
  dataType: string;
  populatedCount: number;
  recordBase: number;
  hasFormula: boolean;
  hubspotDefined: boolean;
  archivable: boolean;
  hidden: boolean;
  formField: boolean;
  referencedInWorkflows: number;
  workflowRefs: Array<{ id: string; name: string | null }>;
  lastModifiedAt: string | null;
  confidence: number;
  recommendation: string;
  status: string;
  reason: {
    factors: Array<{ factor: string; weight: number; triggered: boolean }>;
    notes: string[];
  };
  errorMessage: string | null;
};

const RECOMMENDATION_STYLES: Record<string, string> = {
  archive: "bg-emerald-100 text-emerald-900",
  review: "bg-amber-100 text-amber-900",
  keep: "bg-zinc-100 text-zinc-700",
};

export function FindingCard({ finding }: { finding: ReviewFinding }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(finding.errorMessage);

  const handleAcknowledge = () => {
    setError(null);
    startTransition(async () => {
      const result = await acknowledgeProperty(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleSuppress = () => {
    setError(null);
    startTransition(async () => {
      const result = await suppressProperty(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleArchive = () => {
    setError(null);
    startTransition(async () => {
      const result = await archivePropertyFinding(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const canAct = finding.status === "pending" || finding.status === "failed";
  const populatedPct =
    finding.recordBase > 0
      ? ((Math.max(finding.populatedCount, 0) / finding.recordBase) * 100).toFixed(2)
      : "0";

  return (
    <Card className={pending ? "opacity-60" : ""}>
      <CardContent className="p-0">
        <div className="flex items-center justify-between p-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((e) => !e)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded((ex) => !ex);
              }
            }}
            className="flex flex-1 cursor-pointer items-center gap-3 text-left select-none"
          >
            <span className="text-muted-foreground text-xs">
              {expanded ? "▼" : "▶"}
            </span>
            <div>
              <div className="font-medium">
                {finding.propertyLabel}
                <span className="text-muted-foreground font-mono text-xs">
                  {" "}
                  ({finding.propertyName})
                </span>
              </div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                <span className="capitalize">{finding.objectType}</span>
                <span>•</span>
                <span
                  className={`rounded px-1.5 py-0.5 ${
                    RECOMMENDATION_STYLES[finding.recommendation] ??
                    "bg-zinc-100"
                  }`}
                >
                  {finding.recommendation}
                </span>
                <span>•</span>
                <span>{Math.round(finding.confidence * 100)}% confidence</span>
                <span>•</span>
                <span>
                  {finding.populatedCount < 0
                    ? "count ?"
                    : `${finding.populatedCount.toLocaleString()} populated (${populatedPct}%)`}
                </span>
                {finding.referencedInWorkflows > 0 && (
                  <>
                    <span>•</span>
                    <span className="text-amber-700">
                      {finding.referencedInWorkflows} workflow ref
                      {finding.referencedInWorkflows !== 1 ? "s" : ""}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <Badge variant={statusVariant(finding.status)}>
              {finding.status}
            </Badge>
            {canAct && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAcknowledge}
                  disabled={pending}
                >
                  Acknowledge
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSuppress}
                  disabled={pending}
                >
                  Suppress
                </Button>
                {finding.recommendation !== "keep" && (
                  <ArchiveButton
                    finding={finding}
                    pending={pending}
                    onConfirm={handleArchive}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {expanded && (
          <div className="border-t p-4">
            {error && (
              <div className="bg-destructive/10 text-destructive mb-3 rounded p-2 text-xs">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                <div className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
                  Property metadata
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Group</dt>
                  <dd className="font-mono">
                    {finding.propertyGroupName ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="font-mono">
                    {finding.dataType} · {finding.fieldType}
                  </dd>
                  <dt className="text-muted-foreground">Populated</dt>
                  <dd>
                    {finding.populatedCount < 0
                      ? "count unknown"
                      : `${finding.populatedCount.toLocaleString()} / ${finding.recordBase.toLocaleString()} (${populatedPct}%)`}
                  </dd>
                  <dt className="text-muted-foreground">HubSpot-defined</dt>
                  <dd>{finding.hubspotDefined ? "yes" : "no"}</dd>
                  <dt className="text-muted-foreground">Archivable</dt>
                  <dd>{finding.archivable ? "yes" : "no (locked)"}</dd>
                  <dt className="text-muted-foreground">Has formula</dt>
                  <dd>{finding.hasFormula ? "yes" : "no"}</dd>
                  <dt className="text-muted-foreground">Form field</dt>
                  <dd>{finding.formField ? "yes" : "no"}</dd>
                  <dt className="text-muted-foreground">Hidden</dt>
                  <dd>{finding.hidden ? "yes" : "no"}</dd>
                  <dt className="text-muted-foreground">Last modified</dt>
                  <dd>
                    {finding.lastModifiedAt
                      ? new Date(finding.lastModifiedAt).toLocaleDateString()
                      : "—"}
                  </dd>
                </dl>
              </div>

              <div>
                <div className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
                  Scoring breakdown
                </div>
                <ul className="space-y-1 text-xs">
                  {finding.reason.factors.map((f, i) => (
                    <li
                      key={i}
                      className={
                        f.triggered
                          ? "text-foreground"
                          : "text-muted-foreground line-through"
                      }
                    >
                      <span className="tabular-nums">
                        {f.triggered ? `+${f.weight.toFixed(2)}` : "  0.00"}
                      </span>
                      {" — "}
                      {f.factor}
                    </li>
                  ))}
                </ul>
                {finding.reason.notes.length > 0 && (
                  <>
                    <div className="text-muted-foreground mt-3 mb-1 text-xs uppercase tracking-wide">
                      Hard caps applied
                    </div>
                    <ul className="text-destructive space-y-1 text-xs">
                      {finding.reason.notes.map((n, i) => (
                        <li key={i}>• {n}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>

            {finding.workflowRefs.length > 0 && (
              <div className="mt-6">
                <div className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
                  Workflow references ({finding.workflowRefs.length})
                </div>
                <ul className="space-y-1 text-sm">
                  {finding.workflowRefs.map((w) => (
                    <li key={w.id} className="font-mono text-xs">
                      {w.name ?? w.id}{" "}
                      <span className="text-muted-foreground">({w.id})</span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-2 text-xs">
                  Detected via substring match on workflow JSON. False positives
                  are possible (property name appears in a description without
                  being actively used).
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ArchiveButton({
  finding,
  pending,
  onConfirm,
}: {
  finding: ReviewFinding;
  pending: boolean;
  onConfirm: () => void;
}) {
  const isRetry = finding.status === "failed";
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button size="sm" disabled={pending} variant="destructive">
            {isRetry ? "Retry archive" : "Archive"}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Archive <code>{finding.propertyName}</code>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            HubSpot archives the property (90-day recovery in the recycling
            bin). If the property is referenced by any workflow, form, list,
            report, or custom object schema, HubSpot will refuse and the error
            will appear here.
            <span className="mt-2 block text-xs">
              Object: <strong>{finding.objectType}</strong> · Confidence:{" "}
              <strong>{Math.round(finding.confidence * 100)}%</strong>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {isRetry ? "Retry" : "Archive"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function statusVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "archived":
      return "default";
    case "acknowledged":
      return "secondary";
    case "failed":
      return "destructive";
    case "stale":
      return "outline";
    default:
      return "outline";
  }
}
