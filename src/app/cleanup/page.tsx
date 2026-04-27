import Link from "next/link";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Force dynamic so past-audits list reflects live DB on every request.
export const dynamic = "force-dynamic";

export default async function CleanupIndexPage() {
  const [propertyAudits, listAudits, workflowAudits, formAudits] = await Promise.all([
    db.propertyAuditRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    db.listAuditRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    db.workflowAuditRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    db.formAuditRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← Dashboard
          </Link>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">
            HubSpot Cleanup
          </h1>
          <p className="text-muted-foreground mt-1">
            Audit unused properties and stale lists, then archive them safely.
          </p>
        </div>
      </header>

      <section className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Properties</CardTitle>
            <CardDescription>
              Find custom properties that are empty or unreferenced in workflows.
              Archive is a HubSpot-native soft delete (90-day recovery).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/cleanup/properties/new"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
            >
              + New property audit
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lists &amp; segments</CardTitle>
            <CardDescription>
              Find dormant lists with no members or no workflow references.
              Delete is permanent — no recovery.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/cleanup/lists/new"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
            >
              + New list audit
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workflows</CardTitle>
            <CardDescription>
              Find disabled or dormant HubSpot automation workflows.
              Recommended action is disable (reversible) — not hard delete.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/cleanup/workflows/new"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
            >
              + New workflow audit
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Forms</CardTitle>
            <CardDescription>
              Find forms that have never been submitted or haven&apos;t been
              used in 12+ months. Archive is reversible.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/cleanup/forms/new"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
            >
              + New form audit
            </Link>
          </CardContent>
        </Card>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Past property audits</h2>
        {propertyAudits.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center">
              No property audits yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {propertyAudits.map((a) => {
              const objectTypes = (JSON.parse(a.objectTypes) as string[]).join(
                ", "
              );
              return (
                <Link
                  key={a.id}
                  href={`/cleanup/properties/${a.id}`}
                  className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={a.status} />
                    <div>
                      <div className="font-medium capitalize">
                        Property audit — {objectTypes}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {a.startedAt.toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-right text-sm">
                    <div>
                      {a.propertiesScanned.toLocaleString()}
                      {a.totalProperties
                        ? ` / ${a.totalProperties.toLocaleString()}`
                        : ""}{" "}
                      properties
                    </div>
                    <div>{a.findingsCount} findings</div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {listAudits.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Past list audits</h2>
          <div className="space-y-2">
            {listAudits.map((a) => (
              <Link
                key={a.id}
                href={`/cleanup/lists/${a.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={a.status} />
                  <div>
                    <div className="font-medium">List audit</div>
                    <div className="text-muted-foreground text-xs">
                      {a.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>
                    {a.listsScanned.toLocaleString()} lists
                  </div>
                  <div>{a.findingsCount} findings</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {workflowAudits.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Past workflow audits</h2>
          <div className="space-y-2">
            {workflowAudits.map((a) => (
              <Link
                key={a.id}
                href={`/cleanup/workflows/${a.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={a.status} />
                  <div>
                    <div className="font-medium">Workflow audit</div>
                    <div className="text-muted-foreground text-xs">
                      {a.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>
                    {a.workflowsScanned.toLocaleString()} workflows
                  </div>
                  <div>{a.findingsCount} findings</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {formAudits.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Past form audits</h2>
          <div className="space-y-2">
            {formAudits.map((a) => (
              <Link
                key={a.id}
                href={`/cleanup/forms/${a.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={a.status} />
                  <div>
                    <div className="font-medium">Form audit</div>
                    <div className="text-muted-foreground text-xs">
                      {a.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>
                    {a.formsScanned.toLocaleString()} forms
                  </div>
                  <div>{a.findingsCount} findings</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    "default" | "secondary" | "destructive" | "outline"
  > = {
    queued: "outline",
    running: "secondary",
    complete: "default",
    failed: "destructive",
  };
  return <Badge variant={variants[status] ?? "outline"}>{status}</Badge>;
}
