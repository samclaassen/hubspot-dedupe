import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { runWorkflowAudit } from "@/lib/workflow-auditor";
import {
  WORKFLOW_SCORING_VERSION,
  WORKFLOW_RECOMMENDATION_THRESHOLDS,
} from "@/lib/cleanup-types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const WORKFLOW_RULE_SNAPSHOT = {
  kind: "workflow-audit",
  version: WORKFLOW_SCORING_VERSION,
  thresholds: WORKFLOW_RECOMMENDATION_THRESHOLDS,
  hardCaps: [
    "isEnabled === true → max 0.6 (never auto-disable active workflows)",
    "isEnabled + updated within 3 months → score 0 (active automation)",
  ],
  notes:
    "HubSpot doesn't expose per-workflow enrollment/last-fired counts, so dormancy is inferred from updatedAt + revisionId only. Recommendation is 'disable' (reversible via PUT isEnabled=true), not 'delete'.",
};

async function startWorkflowAudit() {
  "use server";
  const run = await db.workflowAuditRun.create({
    data: {
      status: "queued",
      ruleSet: JSON.stringify(WORKFLOW_RULE_SNAPSHOT),
    },
  });
  void runWorkflowAudit(run.id);
  redirect(`/cleanup/workflows/${run.id}`);
}

export default function NewWorkflowAuditPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6">
        <Link
          href="/cleanup"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Cleanup
        </Link>
      </div>

      <h1 className="mb-2 text-3xl font-bold tracking-tight">
        New workflow audit
      </h1>
      <p className="text-muted-foreground mb-6">
        Find disabled and dormant HubSpot automation workflows. The recommended
        action is <strong>disable</strong> (reversible — just flip{" "}
        <code>isEnabled</code> back to true). Hard delete requires HubSpot
        Support to recover, so it&apos;s out of scope for v1.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
          <CardDescription>
            Audits every workflow the private-app token can see (across all object
            types the bot has access to).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={startWorkflowAudit}>
            <div className="mb-6 space-y-2 text-sm">
              <div className="font-medium">What this does:</div>
              <ul className="text-muted-foreground list-inside list-disc space-y-1">
                <li>
                  Enumerates every workflow via{" "}
                  <code>GET /automation/v4/flows</code>
                </li>
                <li>
                  Fetches full definition per workflow (for action count +
                  description)
                </li>
                <li>
                  Scores on <code>isEnabled</code>, dormancy (&gt;12 and &gt;24
                  months), action count, revisionId (=1 means never refined),
                  and disposable naming patterns
                </li>
                <li>
                  Any enabled workflow is hard-capped at 0.6 (review, never
                  auto-disable)
                </li>
                <li>
                  Recommends <strong>disable</strong> (≥0.85),{" "}
                  <strong>review</strong> (0.50–0.85), or{" "}
                  <strong>keep</strong> (&lt;0.50)
                </li>
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Scan time: ~1–2 minutes (1 GET per workflow to fetch detail).
              </p>
            </div>

            <Button type="submit" size="lg">
              Start workflow audit
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
