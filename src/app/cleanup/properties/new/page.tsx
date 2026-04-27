import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { runPropertyAudit } from "@/lib/property-auditor";
import {
  PROPERTY_SCORING_VERSION,
  PROPERTY_RECOMMENDATION_THRESHOLDS,
  AUDIT_OBJECT_TYPES,
  type AuditObjectType,
} from "@/lib/cleanup-types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const PROPERTY_RULE_SNAPSHOT = {
  kind: "property-audit",
  version: PROPERTY_SCORING_VERSION,
  thresholds: PROPERTY_RECOMMENDATION_THRESHOLDS,
  hardCaps: [
    "hubspotDefined → keep (never archive)",
    "!archivable → max 0.4, review",
    "hasFormula → max 0.5, review",
  ],
  notes:
    "Scoring weights live in src/lib/cleanup-scoring.ts. This snapshot is for audit reproducibility.",
};

async function startPropertyAudit(formData: FormData) {
  "use server";

  const selected = formData.getAll("objectTypes");
  const objectTypes = selected.filter((v): v is AuditObjectType =>
    AUDIT_OBJECT_TYPES.includes(v as AuditObjectType)
  );

  if (objectTypes.length === 0) {
    redirect("/cleanup/properties/new?error=no-objects");
  }

  const run = await db.propertyAuditRun.create({
    data: {
      objectTypes: JSON.stringify(objectTypes),
      status: "queued",
      ruleSet: JSON.stringify({
        ...PROPERTY_RULE_SNAPSHOT,
        selectedObjectTypes: objectTypes,
      }),
    },
  });

  void runPropertyAudit(run.id);
  redirect(`/cleanup/properties/${run.id}`);
}

export default async function NewPropertyAuditPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await props.searchParams;

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
        New property audit
      </h1>
      <p className="text-muted-foreground mb-6">
        Detect unused or unreferenced properties across the selected CRM objects.
        Each property gets scored 0.0–1.0; nothing is archived automatically.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
          <CardDescription>
            Pick which HubSpot objects to audit. The scan counts populated
            records per property and cross-references all workflows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={startPropertyAudit}>
            <fieldset className="mb-6">
              <legend className="mb-3 text-sm font-medium">Object types</legend>
              <div className="space-y-2">
                {AUDIT_OBJECT_TYPES.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="objectTypes"
                      value={t}
                      defaultChecked
                      className="accent-foreground h-4 w-4"
                    />
                    <span className="capitalize">{t}</span>
                  </label>
                ))}
              </div>
              {error === "no-objects" && (
                <p className="text-destructive mt-2 text-xs">
                  Pick at least one object type.
                </p>
              )}
            </fieldset>

            <div className="mb-6 space-y-2 text-sm">
              <div className="font-medium">What this does:</div>
              <ul className="text-muted-foreground list-inside list-disc space-y-1">
                <li>
                  Lists every non-archived property per object type
                </li>
                <li>
                  Counts populated records per property via HubSpot Search API
                </li>
                <li>
                  Cross-references all workflows for property name mentions
                </li>
                <li>
                  Scores each property on hubspot-defined, archivable, formula,
                  populated ratio, workflow refs, and last-modified age
                </li>
                <li>
                  Recommends <strong>archive</strong>, <strong>review</strong>,
                  or <strong>keep</strong> per property
                </li>
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Scan time: 3–8 minutes depending on property count. Workflow
                scan is the slowest step — it runs once and is shared across
                objects. Archives are manual in v1 (no auto-archive).
              </p>
            </div>

            <Button type="submit" size="lg">
              Start property audit
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
