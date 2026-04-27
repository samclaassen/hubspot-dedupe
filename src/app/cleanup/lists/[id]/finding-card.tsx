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
  acknowledgeList,
  deleteListFinding,
  suppressList,
} from "./actions";

export type ReviewListFinding = {
  id: string;
  hubspotListId: string;
  name: string;
  processingType: string;
  objectTypeId: string;
  createdAt: string;
  updatedAt: string;
  filtersUpdatedAt: string | null;
  memberCount: number;
  referenceCount: number;
  lastRecordAddedAt: string | null;
  lastRecordRemovedAt: string | null;
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
  delete: "bg-red-100 text-red-900",
  review: "bg-amber-100 text-amber-900",
  keep: "bg-zinc-100 text-zinc-700",
};

const OBJECT_TYPE_LABELS: Record<string, string> = {
  "0-1": "contacts",
  "0-2": "companies",
  "0-3": "deals",
  "0-5": "tickets",
};

export function FindingCard({ finding }: { finding: ReviewListFinding }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(finding.errorMessage);

  const handleAcknowledge = () => {
    setError(null);
    startTransition(async () => {
      const result = await acknowledgeList(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleSuppress = () => {
    setError(null);
    startTransition(async () => {
      const result = await suppressList(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteListFinding(finding.id);
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
                <span className="uppercase">{finding.processingType}</span>
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
                  {finding.memberCount.toLocaleString()} member
                  {finding.memberCount !== 1 ? "s" : ""}
                </span>
                {finding.referenceCount > 0 && (
                  <>
                    <span>•</span>
                    <span className="text-amber-700">
                      {finding.referenceCount} ref
                      {finding.referenceCount !== 1 ? "s" : ""}
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
                  <DeleteButton
                    finding={finding}
                    pending={pending}
                    onConfirm={handleDelete}
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
                  List metadata
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">List ID</dt>
                  <dd className="font-mono">{finding.hubspotListId}</dd>
                  <dt className="text-muted-foreground">Object type</dt>
                  <dd>{objectTypeLabel}</dd>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd>{finding.processingType}</dd>
                  <dt className="text-muted-foreground">Members</dt>
                  <dd>{finding.memberCount.toLocaleString()}</dd>
                  <dt className="text-muted-foreground">References</dt>
                  <dd>
                    {finding.referenceCount}
                    {finding.referenceCount > 0 &&
                      " (workflows/reports use this list)"}
                  </dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{new Date(finding.createdAt).toLocaleDateString()}</dd>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd>{new Date(finding.updatedAt).toLocaleDateString()}</dd>
                  {finding.filtersUpdatedAt && (
                    <>
                      <dt className="text-muted-foreground">Filters updated</dt>
                      <dd>
                        {new Date(finding.filtersUpdatedAt).toLocaleDateString()}
                      </dd>
                    </>
                  )}
                  {finding.lastRecordAddedAt && (
                    <>
                      <dt className="text-muted-foreground">Last add</dt>
                      <dd>
                        {new Date(finding.lastRecordAddedAt).toLocaleDateString()}
                      </dd>
                    </>
                  )}
                  {finding.lastRecordRemovedAt && (
                    <>
                      <dt className="text-muted-foreground">Last remove</dt>
                      <dd>
                        {new Date(
                          finding.lastRecordRemovedAt
                        ).toLocaleDateString()}
                      </dd>
                    </>
                  )}
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteButton({
  finding,
  pending,
  onConfirm,
}: {
  finding: ReviewListFinding;
  pending: boolean;
  onConfirm: () => void;
}) {
  const isRetry = finding.status === "failed";
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button size="sm" disabled={pending} variant="destructive">
            {isRetry ? "Retry delete" : "Delete"}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete &ldquo;{finding.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            <strong>This cannot be undone.</strong> HubSpot hard-deletes the
            list — there is no 90-day recovery like properties have. The tool
            re-checks the live reference count right before deleting; if any
            workflow/report now references the list, the action is refused.
            <span className="mt-2 block text-xs">
              List ID: <strong>{finding.hubspotListId}</strong> · Confidence:{" "}
              <strong>{Math.round(finding.confidence * 100)}%</strong>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {isRetry ? "Retry" : "Delete"}
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
    case "deleted":
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
