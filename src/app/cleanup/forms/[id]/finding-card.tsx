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
  acknowledgeForm,
  archiveFormFinding,
  suppressForm,
} from "./actions";

export type ReviewFormFinding = {
  id: string;
  hubspotFormId: string;
  name: string;
  formType: string;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
  lastSubmittedAt: string | null;
  submissionsSeen: boolean;
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

export function FindingCard({ finding }: { finding: ReviewFormFinding }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(finding.errorMessage);

  const handleAcknowledge = () => {
    setError(null);
    startTransition(async () => {
      const result = await acknowledgeForm(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };
  const handleSuppress = () => {
    setError(null);
    startTransition(async () => {
      const result = await suppressForm(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };
  const handleArchive = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveFormFinding(finding.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const canAct = finding.status === "pending" || finding.status === "failed";
  const lastSub = finding.lastSubmittedAt
    ? new Date(finding.lastSubmittedAt).toLocaleDateString()
    : "never";

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
                <span className="uppercase">{finding.formType}</span>
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
                  {finding.fieldCount} field{finding.fieldCount !== 1 ? "s" : ""}
                </span>
                <span>•</span>
                <span>
                  {finding.submissionsSeen
                    ? `last submit: ${lastSub}`
                    : "never submitted"}
                </span>
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
                  Form metadata
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Form ID</dt>
                  <dd className="font-mono">{finding.hubspotFormId}</dd>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd>{finding.formType}</dd>
                  <dt className="text-muted-foreground">Fields</dt>
                  <dd>{finding.fieldCount}</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{new Date(finding.createdAt).toLocaleDateString()}</dd>
                  <dt className="text-muted-foreground">Last updated</dt>
                  <dd>{new Date(finding.updatedAt).toLocaleDateString()}</dd>
                  <dt className="text-muted-foreground">Last submission</dt>
                  <dd>{lastSub}</dd>
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

function ArchiveButton({
  finding,
  pending,
  onConfirm,
}: {
  finding: ReviewFormFinding;
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
            Archive &ldquo;{finding.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            <strong>Reversible.</strong> Sets{" "}
            <code>archived=true</code> on the form via HubSpot&apos;s PATCH
            endpoint. You can unarchive from HubSpot&apos;s UI.
            <span className="mt-2 block text-xs">
              Form ID: <strong>{finding.hubspotFormId}</strong> · Confidence:{" "}
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
