import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { runFormAudit } from "@/lib/form-auditor";
import {
  FORM_SCORING_VERSION,
  FORM_RECOMMENDATION_THRESHOLDS,
} from "@/lib/cleanup-types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const FORM_RULE_SNAPSHOT = {
  kind: "form-audit",
  version: FORM_SCORING_VERSION,
  thresholds: FORM_RECOMMENDATION_THRESHOLDS,
  hardCaps: [
    "submitted within last 3 months → score 0, keep (actively used)",
    "form < 30 days old → max 0.5, review (give it a chance)",
  ],
  notes:
    "Uses /form-integrations/v1/submissions/forms/{id} for the last-submission signal. Archive is reversible via PATCH archived=true.",
};

async function startFormAudit() {
  "use server";
  const run = await db.formAuditRun.create({
    data: {
      status: "queued",
      ruleSet: JSON.stringify(FORM_RULE_SNAPSHOT),
    },
  });
  void runFormAudit(run.id);
  redirect(`/cleanup/forms/${run.id}`);
}

export default function NewFormAuditPage() {
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
        New form audit
      </h1>
      <p className="text-muted-foreground mb-6">
        Find HubSpot forms that have never been submitted, haven&apos;t been
        submitted in a long time, or are obvious test/draft scaffolding.
        Archive is reversible.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
          <CardDescription>
            Audits every non-archived form the private-app token can see.
            Fetches the latest-submission timestamp for each to score staleness.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={startFormAudit}>
            <div className="mb-6 space-y-2 text-sm">
              <div className="font-medium">What this does:</div>
              <ul className="text-muted-foreground list-inside list-disc space-y-1">
                <li>
                  Enumerates every form via <code>GET /marketing/v3/forms</code>
                </li>
                <li>
                  For each form, fetches the most recent submission via{" "}
                  <code>/form-integrations/v1/submissions/forms/{"{id}"}</code>
                </li>
                <li>
                  Scores on never-submitted, stale last-submission (&gt;12 /
                  &gt;24 months), definition dormancy, age, field count, and
                  disposable naming patterns
                </li>
                <li>
                  Hard caps: recently-submitted forms always keep, new forms
                  (&lt;30 days) capped at review
                </li>
                <li>
                  Recommends <strong>archive</strong> (≥0.85),{" "}
                  <strong>review</strong> (0.50–0.85), or{" "}
                  <strong>keep</strong> (&lt;0.50)
                </li>
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Scan time: a minute or two (one submission fetch per form).
                Archive is reversible via HubSpot&apos;s same PATCH endpoint
                with archived=false.
              </p>
            </div>

            <Button type="submit" size="lg">
              Start form audit
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
