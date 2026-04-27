// Server actions for the property-cleanup review UI.
//
// Safety model (mirrors the dedupe tool's merge flow):
//   1. Re-fetch the live property right before archiving.
//   2. Re-score; refuse if recommendation is no longer "archive" (stale).
//   3. Hard-cap checks: never archive hubspotDefined || !archivable.
//   4. DRY_RUN=true turns archive into a log-only no-op (still writes "archived" status to DB).

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { archiveProperty, getProperty, type SupportedAuditObjectType } from "@/lib/hubspot";
import { scoreProperty } from "@/lib/cleanup-scoring";
import { isDryRun } from "@/lib/cleanup-types";

export async function acknowledgeProperty(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.propertyFinding.findUnique({
    where: { id: findingId },
    include: { auditRun: true },
  });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.$transaction([
      db.propertyFinding.update({
        where: { id: findingId },
        data: { status: "acknowledged", decidedAt: new Date() },
      }),
      // Suppress so future audits don't re-flag it. Use upsert to tolerate
      // repeated clicks without violating the unique constraint.
      db.suppressedProperty.upsert({
        where: {
          objectType_propertyName: {
            objectType: finding.objectType,
            propertyName: finding.propertyName,
          },
        },
        update: { reason: "acknowledged via UI" },
        create: {
          objectType: finding.objectType,
          propertyName: finding.propertyName,
          reason: "acknowledged via UI",
        },
      }),
    ]);
    revalidatePath(`/cleanup/properties/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export async function suppressProperty(
  findingId: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const finding = await db.propertyFinding.findUnique({
    where: { id: findingId },
    include: { auditRun: true },
  });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.suppressedProperty.upsert({
      where: {
        objectType_propertyName: {
          objectType: finding.objectType,
          propertyName: finding.propertyName,
        },
      },
      update: { reason: reason ?? "suppressed" },
      create: {
        objectType: finding.objectType,
        propertyName: finding.propertyName,
        reason: reason ?? "suppressed",
      },
    });
    revalidatePath(`/cleanup/properties/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export async function archivePropertyFinding(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.propertyFinding.findUnique({
    where: { id: findingId },
  });
  if (!finding) return { ok: false, error: "Finding not found" };
  if (finding.status === "archived") {
    return { ok: false, error: "Already archived" };
  }

  const objectType = finding.objectType as SupportedAuditObjectType;

  // 1. Re-fetch live state.
  let live;
  try {
    live = await getProperty(objectType, finding.propertyName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // If the property is already gone (404), mark as stale.
    const is404 = /(not found|404)/i.test(msg);
    await db.propertyFinding.update({
      where: { id: findingId },
      data: {
        status: is404 ? "stale" : "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/properties/${finding.auditRunId}`);
    return {
      ok: false,
      error: is404 ? "Property already archived/deleted in HubSpot" : msg,
    };
  }

  // 2. Hard-cap safety.
  if (live.hubspotDefined) {
    await markStale(findingId, "property is HubSpot-defined");
    return { ok: false, error: "Refusing to archive a HubSpot-defined property" };
  }
  const archivable = live.modificationMetadata?.archivable ?? false;
  if (!archivable) {
    await markStale(findingId, "property is not archivable");
    return { ok: false, error: "Property is not archivable (locked)" };
  }

  // 3. Re-score with live data (uses the existing stored populated count /
  //    workflow refs because re-running those would be expensive here).
  const rescored = scoreProperty({
    hubspotDefined: !!live.hubspotDefined,
    archivable,
    hidden: !!live.hidden,
    formField: !!live.formField,
    hasFormula: !!live.calculationFormula,
    lastModifiedAt: live.updatedAt ? new Date(live.updatedAt) : null,
    populatedCount: Math.max(finding.populatedCount, 0),
    recordBase: finding.recordBase,
    referencedInWorkflows: finding.referencedInWorkflows,
  });
  if (rescored.recommendation !== "archive") {
    await markStale(
      findingId,
      `live re-score no longer recommends archive (${rescored.recommendation}, score=${rescored.confidence})`
    );
    return {
      ok: false,
      error: `Refused — property state changed since audit. Recommendation is now "${rescored.recommendation}".`,
    };
  }

  // 4. Archive (or dry-run).
  if (isDryRun()) {
    console.log(
      `[DRY_RUN] Would archive ${objectType}.${finding.propertyName} (findingId=${findingId})`
    );
    await db.propertyFinding.update({
      where: { id: findingId },
      data: {
        status: "archived",
        decidedAt: new Date(),
        errorMessage: "[DRY_RUN] not actually archived in HubSpot",
      },
    });
    revalidatePath(`/cleanup/properties/${finding.auditRunId}`);
    return { ok: true };
  }

  try {
    await archiveProperty(objectType, finding.propertyName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.propertyFinding.update({
      where: { id: findingId },
      data: {
        status: "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/properties/${finding.auditRunId}`);
    return { ok: false, error: msg };
  }

  // 5. Mark archived.
  await db.propertyFinding.update({
    where: { id: findingId },
    data: { status: "archived", decidedAt: new Date(), errorMessage: null },
  });

  // 6. Record the suppression so re-audits don't re-flag the (now-archived) name.
  try {
    await db.suppressedProperty.upsert({
      where: {
        objectType_propertyName: {
          objectType: finding.objectType,
          propertyName: finding.propertyName,
        },
      },
      update: { reason: "archived" },
      create: {
        objectType: finding.objectType,
        propertyName: finding.propertyName,
        reason: "archived",
      },
    });
  } catch {
    // Non-fatal.
  }

  revalidatePath(`/cleanup/properties/${finding.auditRunId}`);
  return { ok: true };
}

async function markStale(findingId: string, note: string) {
  const f = await db.propertyFinding.update({
    where: { id: findingId },
    data: {
      status: "stale",
      decidedAt: new Date(),
      errorMessage: note,
    },
  });
  revalidatePath(`/cleanup/properties/${f.auditRunId}`);
}

/**
 * Fire-and-forget bulk archive of all findings at or above `minScore`.
 * Pre-wired for v1.1 auto-archive; also used by the UI "Archive all" button.
 * Mirrors autoMergePending in src/app/scan/[id]/actions.ts.
 */
export async function bulkArchiveHighConfidence(
  auditRunId: string,
  minScore: number = 0.95
): Promise<{ ok: boolean; total: number; error?: string }> {
  const run = await db.propertyAuditRun.findUnique({
    where: { id: auditRunId },
  });
  if (!run) return { ok: false, total: 0, error: "Audit not found" };

  // Staleness guard: if a previous bulk is still "running" but >5 min old, treat as dead.
  if (run.bulkArchiveStatus === "running") {
    const startedAt = run.bulkArchiveStartedAt?.getTime() ?? 0;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    if (startedAt > fiveMinAgo) {
      return { ok: false, total: 0, error: "Bulk archive already in progress" };
    }
  }

  const eligible = await db.propertyFinding.count({
    where: {
      auditRunId,
      status: "pending",
      recommendation: "archive",
      confidence: { gte: minScore },
    },
  });

  if (eligible === 0) {
    return { ok: true, total: 0 };
  }

  await db.propertyAuditRun.update({
    where: { id: auditRunId },
    data: {
      bulkArchiveStatus: "running",
      bulkArchiveMinScore: minScore,
      bulkArchiveTotal: eligible,
      bulkArchivedCount: 0,
      bulkArchiveFailedCount: 0,
      bulkArchiveStartedAt: new Date(),
      bulkArchiveCompletedAt: null,
      bulkArchiveError: null,
    },
  });

  void runBulkArchiveBackground(auditRunId, minScore);
  revalidatePath(`/cleanup/properties/${auditRunId}`);
  return { ok: true, total: eligible };
}

async function runBulkArchiveBackground(
  auditRunId: string,
  minScore: number
): Promise<void> {
  try {
    // Fetch IDs only first so we don't hold the whole dataset in memory.
    const eligibleIds = await db.propertyFinding.findMany({
      where: {
        auditRunId,
        status: "pending",
        recommendation: "archive",
        confidence: { gte: minScore },
      },
      select: { id: true },
      orderBy: { confidence: "desc" },
    });

    let archived = 0;
    let failed = 0;

    for (const { id } of eligibleIds) {
      // Re-fetch — someone may have clicked Archive/Acknowledge in the UI already.
      const current = await db.propertyFinding.findUnique({ where: { id } });
      if (!current || current.status !== "pending") continue;

      const result = await archivePropertyFinding(id);
      if (result.ok) archived++;
      else failed++;

      // Update progress after every 5 or on change of milestone.
      if ((archived + failed) % 5 === 0) {
        await db.propertyAuditRun.update({
          where: { id: auditRunId },
          data: {
            bulkArchivedCount: archived,
            bulkArchiveFailedCount: failed,
          },
        });
      }
    }

    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkArchiveStatus: "complete",
        bulkArchivedCount: archived,
        bulkArchiveFailedCount: failed,
        bulkArchiveCompletedAt: new Date(),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`runBulkArchiveBackground(${auditRunId}) failed:`, e);
    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkArchiveStatus: "failed",
        bulkArchiveError: message.slice(0, 2000),
        bulkArchiveCompletedAt: new Date(),
      },
    });
  }
}
