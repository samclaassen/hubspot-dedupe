import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { runContactScan, runCompanyScan } from "@/lib/scanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const CONTACT_RULE_SNAPSHOT = {
  tiers: {
    tier1_linkedin: { fields: ["linkedin_profile"], confidence: 1.0 },
    tier1_email: { fields: ["email", "work_email"], confidence: 1.0 },
    tier2_name_company: {
      fields: ["firstname", "lastname", "company", "associatedcompanyid"],
      confidence: 0.95,
    },
    tier3_fuzzy: {
      fields: ["firstname", "lastname", "company", "phone", "jobtitle"],
      confidence_threshold: 0.85,
    },
  },
};

const COMPANY_RULE_SNAPSHOT = {
  tiers: {
    tier1_domain: { fields: ["domain", "website"], confidence: 1.0 },
    tier2_name_fuzzy: { fields: ["name"], confidence: 0.88 },
  },
};

async function startContactScan() {
  "use server";
  const scan = await db.scanRun.create({
    data: {
      objectType: "contact",
      status: "queued",
      ruleSet: JSON.stringify(CONTACT_RULE_SNAPSHOT),
    },
  });
  void runContactScan(scan.id);
  redirect(`/scan/${scan.id}`);
}

async function startCompanyScan() {
  "use server";
  const scan = await db.scanRun.create({
    data: {
      objectType: "company",
      status: "queued",
      ruleSet: JSON.stringify(COMPANY_RULE_SNAPSHOT),
    },
  });
  void runCompanyScan(scan.id);
  redirect(`/scan/${scan.id}`);
}

export default function NewScanPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back
        </Link>
      </div>

      <h1 className="mb-6 text-3xl font-bold tracking-tight">New Scan</h1>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Contacts</CardTitle>
          <CardDescription>
            Scan all contacts for duplicates across 4 tiered detection rules.
            Reads from HubSpot but does not modify any records until you merge.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-6 space-y-2 text-sm">
            <div className="font-medium">Rules applied:</div>
            <ul className="text-muted-foreground list-inside list-disc space-y-1">
              <li>
                <strong>Tier 1.1 — LinkedIn URL</strong> (100% confidence):
                normalized <code>linkedin_profile</code>
              </li>
              <li>
                <strong>Tier 1.2 — Email</strong> (100% confidence): pooled{" "}
                <code>email</code> + <code>work_email</code>, Gmail
                dot-stripping applied
              </li>
              <li>
                <strong>Tier 2.1 — Name + Company</strong> (95% confidence):
                exact or fuzzy name match (≥92) AND same{" "}
                <code>associatedcompanyid</code> or fuzzy company (≥88)
              </li>
              <li>
                <strong>Tier 3 — Fuzzy</strong> (≥85% weighted score): name +
                company + phone + jobtitle, fallback for records not matched by
                higher tiers
              </li>
            </ul>
            <p className="text-muted-foreground mt-3 text-xs">
              Scan time: 3–5 minutes on a ~50k contact portal (Tiers 2/3 add
              CPU time for fuzzy comparisons).
            </p>
          </div>
          <form action={startContactScan}>
            <Button type="submit" size="lg">
              Start contact scan
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Companies</CardTitle>
          <CardDescription>
            Scan all companies for duplicates by normalized domain and fuzzy
            name match.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-6 space-y-2 text-sm">
            <div className="font-medium">Rules applied:</div>
            <ul className="text-muted-foreground list-inside list-disc space-y-1">
              <li>
                <strong>Tier 1 — Domain</strong> (100% confidence): normalized{" "}
                <code>domain</code> and <code>website</code> (strips{" "}
                <code>www.</code>, protocol, path)
              </li>
              <li>
                <strong>Tier 2 — Fuzzy name</strong> (≥88% confidence):{" "}
                <code>token_set_ratio</code> on normalized company name (strips
                legal suffixes like Inc, LLC, Ltd)
              </li>
            </ul>
            <p className="text-muted-foreground mt-3 text-xs">
              Scan time: ~1 minute on a ~25k company portal.
            </p>
          </div>
          <form action={startCompanyScan}>
            <Button type="submit" size="lg">
              Start company scan
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
