// Server actions for the list-cleanup review UI.
//
// Safety model (stricter than properties because list delete is irreversible):
//   1. Re-fetch live list immediately before deleting (via getListDetails).
//   2. Re-score; refuse if recommendation is no longer "delete".
//   3. Hard-cap: refuse if referenceCount > 0 on live data.
//   4. DRY_RUN=true turns delete into a log-only no-op (still writes "deleted" status to DB).

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { deleteList, getListDetails } from "@/lib/hubspot";
import { scoreList } from "@/lib/cleanup-scoring";
import { isDryRun } from "@/lib/cleanup-types";

export async function acknowledgeList(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.listFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.$transaction([
      db.listFinding.update({
        where: { id: findingId },
        data: { status: "acknowledged", decidedAt: new Date() },
      }),
      db.suppressedList.upsert({
        where: { hubspotListId: finding.hubspotListId },
        update: { reason: "acknowledged via UI" },
        create: {
          hubspotListId: finding.hubspotListId,
          reason: "acknowledged via UI",
        },
      }),
    ]);
    revalidatePath(`/cleanup/lists/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function suppressList(
  findingId: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const finding = await db.listFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.suppressedList.upsert({
      where: { hubspotListId: finding.hubspotListId },
      update: { reason: reason ?? "suppressed" },
      create: {
        hubspotListId: finding.hubspotListId,
        reason: reason ?? "suppressed",
      },
    });
    revalidatePath(`/cleanup/lists/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteListFinding(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.listFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "Finding not found" };
  if (finding.status === "deleted") {
    return { ok: false, error: "Already deleted" };
  }

  // 1. Re-fetch live state
  let live;
  try {
    live = await getListDetails(finding.hubspotListId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const is404 = /(404|not found)/i.test(msg);
    await db.listFinding.update({
      where: { id: findingId },
      data: {
        status: is404 ? "stale" : "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/lists/${finding.auditRunId}`);
    return {
      ok: false,
      error: is404 ? "List already deleted in HubSpot" : msg,
    };
  }

  // 2. Hard-cap: check live reference count (the one that matters for safety)
  const extras = live.additionalProperties ?? {};
  const liveRefCount = Number.parseInt(extras.hs_list_reference_count ?? "0", 10);
  if (liveRefCount > 0) {
    await markStale(
      findingId,
      `list is now referenced ${liveRefCount} time(s) — refusing to delete`
    );
    return {
      ok: false,
      error: `Refused — list is referenced ${liveRefCount} time(s) in workflows/reports.`,
    };
  }

  // 3. Re-score with live data
  const rescored = scoreList({
    name: live.name,
    processingType: live.processingType,
    createdAt: new Date(live.createdAt),
    updatedAt: new Date(live.updatedAt),
    filtersUpdatedAt: live.filtersUpdatedAt ? new Date(live.filtersUpdatedAt) : null,
    memberCount: Number.parseInt(extras.hs_list_size ?? "0", 10),
    referenceCount: liveRefCount,
    lastRecordAddedAt: extras.hs_last_record_added_at
      ? new Date(Number.parseInt(extras.hs_last_record_added_at, 10))
      : null,
    lastRecordRemovedAt: extras.hs_last_record_removed_at
      ? new Date(Number.parseInt(extras.hs_last_record_removed_at, 10))
      : null,
  });
  if (rescored.recommendation !== "delete") {
    await markStale(
      findingId,
      `live re-score no longer recommends delete (${rescored.recommendation}, score=${rescored.confidence})`
    );
    return {
      ok: false,
      error: `Refused — list state changed since audit. Recommendation is now "${rescored.recommendation}".`,
    };
  }

  // 4. Delete (or dry-run)
  if (isDryRun()) {
    console.log(
      `[DRY_RUN] Would delete list ${finding.hubspotListId} "${finding.name}" (findingId=${findingId})`
    );
    await db.listFinding.update({
      where: { id: findingId },
      data: {
        status: "deleted",
        decidedAt: new Date(),
        errorMessage: "[DRY_RUN] not actually deleted in HubSpot",
      },
    });
    revalidatePath(`/cleanup/lists/${finding.auditRunId}`);
    return { ok: true };
  }

  try {
    await deleteList(finding.hubspotListId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.listFinding.update({
      where: { id: findingId },
      data: {
        status: "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/lists/${finding.auditRunId}`);
    return { ok: false, error: msg };
  }

  // 5. Mark deleted + suppress
  await db.listFinding.update({
    where: { id: findingId },
    data: { status: "deleted", decidedAt: new Date(), errorMessage: null },
  });

  try {
    await db.suppressedList.upsert({
      where: { hubspotListId: finding.hubspotListId },
      update: { reason: "deleted" },
      create: { hubspotListId: finding.hubspotListId, reason: "deleted" },
    });
  } catch {
    // non-fatal
  }

  revalidatePath(`/cleanup/lists/${finding.auditRunId}`);
  return { ok: true };
}

async function markStale(findingId: string, note: string) {
  const f = await db.listFinding.update({
    where: { id: findingId },
    data: {
      status: "stale",
      decidedAt: new Date(),
      errorMessage: note,
    },
  });
  revalidatePath(`/cleanup/lists/${f.auditRunId}`);
}

/**
 * Fire-and-forget bulk delete of findings at or above `minScore`.
 * Mirrors bulkArchiveHighConfidence in properties/[id]/actions.ts.
 * Uses a higher default threshold (0.95) than properties (0.95) because
 * delete is irreversible; v1 review-only keeps it off the weekly cron.
 */
export async function bulkDeleteHighConfidence(
  auditRunId: string,
  minScore: number = 0.95
): Promise<{ ok: boolean; total: number; error?: string }> {
  const run = await db.listAuditRun.findUnique({ where: { id: auditRunId } });
  if (!run) return { ok: false, total: 0, error: "Audit not found" };

  if (run.bulkDeleteStatus === "running") {
    const startedAt = run.bulkDeleteStartedAt?.getTime() ?? 0;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    if (startedAt > fiveMinAgo) {
      return { ok: false, total: 0, error: "Bulk delete already in progress" };
    }
  }

  const eligible = await db.listFinding.count({
    where: {
      auditRunId,
      status: "pending",
      recommendation: "delete",
      confidence: { gte: minScore },
    },
  });

  if (eligible === 0) return { ok: true, total: 0 };

  await db.listAuditRun.update({
    where: { id: auditRunId },
    data: {
      bulkDeleteStatus: "running",
      bulkDeleteMinScore: minScore,
      bulkDeleteTotal: eligible,
      bulkDeletedCount: 0,
      bulkDeleteFailedCount: 0,
      bulkDeleteStartedAt: new Date(),
      bulkDeleteCompletedAt: null,
      bulkDeleteError: null,
    },
  });

  void runBulkDeleteBackground(auditRunId, minScore);
  revalidatePath(`/cleanup/lists/${auditRunId}`);
  return { ok: true, total: eligible };
}

async function runBulkDeleteBackground(
  auditRunId: string,
  minScore: number
): Promise<void> {
  try {
    const eligibleIds = await db.listFinding.findMany({
      where: {
        auditRunId,
        status: "pending",
        recommendation: "delete",
        confidence: { gte: minScore },
      },
      select: { id: true },
      orderBy: { confidence: "desc" },
    });

    let deleted = 0;
    let failed = 0;

    for (const { id } of eligibleIds) {
      const current = await db.listFinding.findUnique({ where: { id } });
      if (!current || current.status !== "pending") continue;

      const result = await deleteListFinding(id);
      if (result.ok) deleted++;
      else failed++;

      if ((deleted + failed) % 5 === 0) {
        await db.listAuditRun.update({
          where: { id: auditRunId },
          data: {
            bulkDeletedCount: deleted,
            bulkDeleteFailedCount: failed,
          },
        });
      }
    }

    await db.listAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkDeleteStatus: "complete",
        bulkDeletedCount: deleted,
        bulkDeleteFailedCount: failed,
        bulkDeleteCompletedAt: new Date(),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`runBulkDeleteBackground(${auditRunId}) failed:`, e);
    await db.listAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkDeleteStatus: "failed",
        bulkDeleteError: message.slice(0, 2000),
        bulkDeleteCompletedAt: new Date(),
      },
    });
  }
}
