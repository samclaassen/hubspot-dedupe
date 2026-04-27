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
  acknowledgeWorkflow,
  disableWorkflowFinding,
  suppressWorkflow,
} from "./actions";

export type ReviewWorkflowFinding = {
  id: string;
  hubspotFlowId: string;
  name: string;
  flowType: string;
  objectTypeId: string;
  isEnabled: boolean;
  revisionId: string;
  description: string | null;
  actionCount: number;
  createdAt: string;
  updatedAt: string;
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
  disable: "bg-orange-100 text-orange-900",
  review: "bg-amber-100 text-amber-900",
  keep: "bg-zinc-100 text-zinc-700",
};

const OBJECT_TYPE_LABELS: Record<string, string> = {
  "0-1": "contacts",
  "0-2": "companies",
  "0-3": "deals",
  "0-5": "tickets",
};

export function FindingCard({ finding }: { finding: ReviewWorkflowFinding }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(finding.errorMessage);

  const handleAcknowledge = () => {
    setError(null);
    startTransition(async () => {
      const result = await acknowledgeWorkflow(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleSuppress = () => {
    setError(null);
    startTransition(async () => {
      const result = await suppressWorkflow(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleDisable = () => {
    setError(null);
    startTransition(async () => {
      const result = await disableWorkflowFinding(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const canAct = finding.status === "pending" || finding.status === "failed";
  const objectTypeLabel =
    OBJECT_TYPE_LABELS[finding.objectTypeId] ?? finding.objectTypeId;

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
              <div className="font-medium">{finding.name}</div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                <span>{objectTypeLabel}</span>
                <span>•</span>
                <span className={finding.isEnabled ? "text-emerald-700" : "text-zinc-500"}>
                  {finding.isEnabled ? "enabled" : "disabled"}
                </span>
                <span>•</span>
                <span
                  className={`rounded px-1.5 py-0.5 ${
                    RECOMMENDATION_STYLES[finding.recommendation] ?? "bg-zinc-100"
                  }`}
                >
                  {finding.recommendation}
                </span>
                <span>•</span>
                <span>{Math.round(finding.confidence * 100)}% confidence</span>
                <span>•</span>
                <span>
                  {finding.actionCount} action
                  {finding.actionCount !== 1 ? "s" : ""}
                </span>
                <span>•</span>
                <span>rev {finding.revisionId}</span>
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
                {finding.recommendation !== "keep" && finding.isEnabled && (
                  <DisableButton
                    finding={finding}
                    pending={pending}
                    onConfirm={handleDisable}
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
                  Workflow metadata
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Flow ID</dt>
                  <dd className="font-mono">{finding.hubspotFlowId}</dd>
                  <dt className="text-muted-foreground">Object type</dt>
                  <dd>{objectTypeLabel}</dd>
                  <dt className="text-muted-foreground">Flow type</dt>
                  <dd>{finding.flowType}</dd>
                  <dt className="text-muted-foreground">Enabled</dt>
                  <dd>{finding.isEnabled ? "yes" : "no"}</dd>
                  <dt className="text-muted-foreground">Actions</dt>
                  <dd>{finding.actionCount}</dd>
                  <dt className="text-muted-foreground">Revision</dt>
                  <dd>{finding.revisionId}</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{new Date(finding.createdAt).toLocaleDateString()}</dd>
                  <dt className="text-muted-foreground">Last updated</dt>
                  <dd>{new Date(finding.updatedAt).toLocaleDateString()}</dd>
                </dl>
                {finding.description && (
                  <div className="mt-3">
                    <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                      Description
                    </div>
                    <p className="text-sm">{finding.description}</p>
                  </div>
                )}
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DisableButton({
  finding,
  pending,
  onConfirm,
}: {
  finding: ReviewWorkflowFinding;
  pending: boolean;
  onConfirm: () => void;
}) {
  const isRetry = finding.status === "failed";
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button size="sm" disabled={pending} variant="destructive">
            {isRetry ? "Retry disable" : "Disable"}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Disable &ldquo;{finding.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            <strong>Reversible.</strong> This sets{" "}
            <code>isEnabled=false</code> in HubSpot via{" "}
            <code>PUT /automation/v4/flows/{finding.hubspotFlowId}</code>.
            To re-enable, flip the toggle in HubSpot&apos;s UI.
            <span className="mt-2 block text-xs">
              Flow ID: <strong>{finding.hubspotFlowId}</strong> · Confidence:{" "}
              <strong>{Math.round(finding.confidence * 100)}%</strong>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {isRetry ? "Retry" : "Disable"}
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
    case "disabled":
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
