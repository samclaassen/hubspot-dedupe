import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { runListAudit } from "@/lib/list-auditor";
import {
  LIST_SCORING_VERSION,
  LIST_RECOMMENDATION_THRESHOLDS,
} from "@/lib/cleanup-types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const LIST_RULE_SNAPSHOT = {
  kind: "list-audit",
  version: LIST_SCORING_VERSION,
  thresholds: LIST_RECOMMENDATION_THRESHOLDS,
  hardCaps: [
    "referenceCount > 0 → max 0.5, review (list in use by workflows/reports)",
    "memberCount > 1000 + recently active → keep",
  ],
  notes:
    "Uses hs_list_reference_count + hs_last_record_added_at / removed_at from the HubSpot /crm/v3/lists/search response — no workflow iteration needed.",
};

async function startListAudit() {
  "use server";
  const run = await db.listAuditRun.create({
    data: {
      status: "queued",
      ruleSet: JSON.stringify(LIST_RULE_SNAPSHOT),
    },
  });
  void runListAudit(run.id);
  redirect(`/cleanup/lists/${run.id}`);
}

export default function NewListAuditPage() {
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
        New list audit
      </h1>
      <p className="text-muted-foreground mb-6">
        Find dormant or unused HubSpot lists. Delete is permanent — no recovery —
        so the default recommendation threshold is conservative.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
          <CardDescription>
            Audits every list the private-app token can see across all object
            types (contacts / companies / custom objects).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={startListAudit}>
            <div className="mb-6 space-y-2 text-sm">
              <div className="font-medium">What this does:</div>
              <ul className="text-muted-foreground list-inside list-disc space-y-1">
                <li>
                  Enumerates every list via <code>POST /crm/v3/lists/search</code>
                </li>
                <li>
                  Reads each list&apos;s reference count, member count, last
                  record added/removed timestamps
                </li>
                <li>
                  Scores on emptiness, dormancy (&gt;12 and &gt;24 months),
                  references, processing type, and disposable naming patterns
                </li>
                <li>
                  Any list with ≥1 workflow/report reference is hard-capped at
                  0.5 (review, never auto-delete)
                </li>
                <li>
                  Recommends <strong>delete</strong> (≥0.85),{" "}
                  <strong>review</strong> (0.50–0.85), or{" "}
                  <strong>keep</strong> (&lt;0.50)
                </li>
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Scan time: typically under a minute. No workflow iteration
                needed — HubSpot already exposes reference counts inline.
              </p>
            </div>

            <Button type="submit" size="lg">
              Start list audit
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
