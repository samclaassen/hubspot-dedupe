import Link from "next/link";
import { getContactsTotal, getCompaniesTotal } from "@/lib/hubspot";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function Home() {
  // Fetch live HubSpot totals + past scan runs + latest scheduled run in parallel
  const [contactsTotal, companiesTotal, scans, latestScheduled] =
    await Promise.all([
      getContactsTotal().catch((e: Error) => ({ error: e.message })),
      getCompaniesTotal().catch((e: Error) => ({ error: e.message })),
      db.scanRun.findMany({
        orderBy: { startedAt: "desc" },
        take: 20,
        include: { _count: { select: { groups: true } } },
      }),
      // Scans created by scripts/weekly-dedupe.ts tag their ruleSet with
      // "scheduled":true. Grab the most recent one for the dashboard widget.
      db.scanRun.findFirst({
        where: { ruleSet: { contains: '"scheduled":true' } },
        orderBy: { startedAt: "desc" },
      }),
    ]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">HubSpot Dedupe</h1>
          <p className="text-muted-foreground mt-1">
            Find and merge duplicate contacts and companies
          </p>
        </div>
        <Link
          href="/scan/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors"
        >
          + New Scan
        </Link>
      </header>

      <section className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Contacts in HubSpot</CardDescription>
            <CardTitle className="text-4xl">
              {typeof contactsTotal === "number"
                ? contactsTotal.toLocaleString()
                : <span className="text-base text-destructive">Auth failed</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {typeof contactsTotal === "number" ? (
              <p className="text-muted-foreground text-sm">
                Ready to scan. Connected via Private App token.
              </p>
            ) : (
              <pre className="text-destructive text-xs whitespace-pre-wrap">
                {contactsTotal.error}
              </pre>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Companies in HubSpot</CardDescription>
            <CardTitle className="text-4xl">
              {typeof companiesTotal === "number"
                ? companiesTotal.toLocaleString()
                : <span className="text-base text-destructive">Auth failed</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {typeof companiesTotal === "number" ? (
              <p className="text-muted-foreground text-sm">Ready to scan.</p>
            ) : (
              <pre className="text-destructive text-xs whitespace-pre-wrap">
                {companiesTotal.error}
              </pre>
            )}
          </CardContent>
        </Card>
      </section>

      {latestScheduled && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Scheduled weekly run</h2>
          <Link
            href={`/scan/${latestScheduled.id}`}
            className="hover:bg-accent flex items-center justify-between rounded-md border-2 border-dashed p-4 transition-colors"
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={latestScheduled.status} />
              <div>
                <div className="font-medium">Last scheduled dedupe</div>
                <div className="text-muted-foreground text-xs">
                  {latestScheduled.startedAt.toLocaleString()}
                  {latestScheduled.autoMergeStatus === "complete"
                    ? " · auto-merge complete"
                    : latestScheduled.autoMergeStatus === "running"
                    ? " · auto-merge running…"
                    : ""}
                </div>
              </div>
            </div>
            <div className="text-muted-foreground text-right text-sm">
              <div>
                {latestScheduled.autoMergedCount.toLocaleString()} merged
                {latestScheduled.autoMergeFailedCount > 0
                  ? ` · ${latestScheduled.autoMergeFailedCount} failed`
                  : ""}
              </div>
              <div>{latestScheduled.groupsFound} duplicate groups</div>
            </div>
          </Link>
          <p className="text-muted-foreground mt-2 text-xs">
            Runs every Sunday at 2:00 AM via launchd on the Mac Mini.
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Past scans</h2>
        {scans.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center">
              No scans yet. Start one to find duplicates.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {scans.map((s) => (
              <Link
                key={s.id}
                href={`/scan/${s.id}`}
                className="hover:bg-accent flex items-center justify-between rounded-md border p-4 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <div>
                    <div className="font-medium capitalize">
                      {s.objectType}s scan
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {s.startedAt.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="text-muted-foreground text-right text-sm">
                  <div>
                    {s.recordsScanned.toLocaleString()}
                    {s.totalRecords ? ` / ${s.totalRecords.toLocaleString()}` : ""} records
                  </div>
                  <div>{s._count.groups} duplicate groups</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "outline",
    running: "secondary",
    complete: "default",
    failed: "destructive",
  };
  return <Badge variant={variants[status] ?? "outline"}>{status}</Badge>;
}
