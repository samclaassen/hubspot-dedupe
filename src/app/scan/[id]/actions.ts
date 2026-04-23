"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  executeContactMerge,
  executeCompanyMerge,
  type ContactRecord,
} from "@/lib/merge";

export async function skipGroup(groupId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Load the group with all members so we can remember the Skip decision
    // across future scans.
    const group = await db.duplicateGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    if (!group) return { ok: false, error: "Group not found" };

    // Update the group status
    await db.duplicateGroup.update({
      where: { id: groupId },
      data: { status: "skipped", decidedAt: new Date() },
    });

    // Record every pair in this group as a SuppressedPair so future scans
    // won't re-surface it. Skip decisions are permanent.
    const ids = group.members.map((m) => m.hubspotId);
    const pairsToSuppress: { objectType: string; idA: string; idB: string }[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [idA, idB] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        pairsToSuppress.push({ objectType: group.objectType, idA, idB });
      }
    }
    if (pairsToSuppress.length > 0) {
      await db.suppressedPair.createMany({
        data: pairsToSuppress,
        // SQLite doesn't support skipDuplicates natively in all Prisma versions,
        // so catch any unique-constraint errors manually if needed.
      }).catch(() => {
        // If bulk insert fails (probably due to existing entries), insert one-by-one
        return Promise.all(
          pairsToSuppress.map((p) =>
            db.suppressedPair.upsert({
              where: {
                objectType_idA_idB: {
                  objectType: p.objectType,
                  idA: p.idA,
                  idB: p.idB,
                },
              },
              create: { ...p, reason: `skipped via group ${groupId}` },
              update: {},
            })
          )
        );
      });
    }

    revalidatePath(`/scan/${group.scanRunId}`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function mergeGroup(
  groupId: string,
  chosenPrimaryId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const group = await db.duplicateGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    if (!group) return { ok: false, error: "Group not found" };
    // Allow retries of failed groups, but not of already-merged or skipped ones
    if (group.status !== "pending" && group.status !== "failed")
      return { ok: false, error: `Group already ${group.status}` };
    if (group.members.length < 2) return { ok: false, error: "Group has fewer than 2 members" };

    const records: ContactRecord[] = group.members.map((m) => ({
      id: m.hubspotId,
      properties: JSON.parse(m.propertiesSnapshot) as Record<string, string | null>,
    }));

    if (!records.some((r) => r.id === chosenPrimaryId)) {
      return { ok: false, error: "Chosen primary is not a group member" };
    }

    const result =
      group.objectType === "company"
        ? await executeCompanyMerge(records, chosenPrimaryId)
        : await executeContactMerge(records, chosenPrimaryId);

    if (result.ok) {
      await db.duplicateGroup.update({
        where: { id: groupId },
        data: {
          status: "merged",
          primaryId: chosenPrimaryId,
          decidedAt: new Date(),
          errorMessage: null,
        },
      });
    } else {
      await db.duplicateGroup.update({
        where: { id: groupId },
        data: {
          status: "failed",
          primaryId: chosenPrimaryId,
          decidedAt: new Date(),
          errorMessage: result.error,
        },
      });
    }

    revalidatePath(`/scan/${group.scanRunId}`);
    return result;
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function skipAllPending(
  scanId: string
): Promise<{ ok: boolean; skipped: number; error?: string }> {
  try {
    const result = await db.duplicateGroup.updateMany({
      where: { scanRunId: scanId, status: "pending" },
      data: { status: "skipped", decidedAt: new Date() },
    });
    revalidatePath(`/scan/${scanId}`);
    return { ok: true, skipped: result.count };
  } catch (err: unknown) {
    return {
      ok: false,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Kick off a bulk auto-merge across ALL pending groups in this scan with
 * matchScore >= minScore. Does NOT wait for completion — marks the scan as
 * auto-merge running, fires the background task, and returns immediately.
 * The UI polls scan status for progress.
 */
export async function autoMergePending(
  scanId: string,
  minScore: number = 0.99
): Promise<{ ok: boolean; total: number; error?: string }> {
  try {
    const scan = await db.scanRun.findUnique({ where: { id: scanId } });
    if (!scan) return { ok: false, total: 0, error: "Scan not found" };

    // Block only if auto-merge is ACTIVELY running. If the status is "running"
    // but the last progress update was >2 minutes ago, treat it as stale
    // (orphaned by a crashed Node process) and allow restart. The resumed run
    // re-queries pending groups, so it naturally skips already-merged ones.
    if (scan.autoMergeStatus === "running") {
      const lastUpdate =
        scan.autoMergeStartedAt ?? new Date(0);
      const lastProgress = await db.duplicateGroup.findFirst({
        where: { scanRunId: scanId, decidedAt: { not: null } },
        orderBy: { decidedAt: "desc" },
        select: { decidedAt: true },
      });
      const mostRecent =
        lastProgress?.decidedAt && lastProgress.decidedAt > lastUpdate
          ? lastProgress.decidedAt
          : lastUpdate;
      const staleCutoffMs = 2 * 60 * 1000; // 2 minutes
      const isStale = Date.now() - mostRecent.getTime() > staleCutoffMs;
      if (!isStale) {
        return {
          ok: false,
          total: 0,
          error: "Auto-merge already running for this scan",
        };
      }
      // Fall through — treat as stale and allow restart
    }

    const total = await db.duplicateGroup.count({
      where: {
        scanRunId: scanId,
        status: "pending",
        matchScore: { gte: minScore },
      },
    });
    if (total === 0) {
      return { ok: false, total: 0, error: "No eligible groups to merge" };
    }

    await db.scanRun.update({
      where: { id: scanId },
      data: {
        autoMergeStatus: "running",
        autoMergeTotal: total,
        autoMergedCount: 0,
        autoMergeFailedCount: 0,
        autoMergeStartedAt: new Date(),
        autoMergeCompletedAt: null,
        autoMergeError: null,
      },
    });

    // Fire-and-forget — don't await
    void runAutoMergeBackground(scanId, minScore);

    revalidatePath(`/scan/${scanId}`);
    return { ok: true, total };
  } catch (err: unknown) {
    return {
      ok: false,
      total: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The actual background worker. Processes all eligible groups sequentially,
 * updating ScanRun progress counters after each group. Survives the original
 * request being closed by the client because Next.js keeps server-side
 * promises running in the Node process.
 */
async function runAutoMergeBackground(
  scanId: string,
  minScore: number
): Promise<void> {
  try {
    // Fetch group IDs only first — we'll load full data one at a time to
    // keep memory low for very large queues (10k+ groups is plausible).
    const groupIds = await db.duplicateGroup.findMany({
      where: {
        scanRunId: scanId,
        status: "pending",
        matchScore: { gte: minScore },
      },
      select: { id: true },
      orderBy: { matchScore: "desc" },
    });

    for (const { id: groupId } of groupIds) {
      // Re-fetch the group with members, since another process may have
      // touched it since we got the list.
      const group = await db.duplicateGroup.findUnique({
        where: { id: groupId },
        include: { members: true },
      });
      if (!group || group.status !== "pending") continue;

      const records: ContactRecord[] = group.members.map((m) => ({
        id: m.hubspotId,
        properties: JSON.parse(m.propertiesSnapshot) as Record<string, string | null>,
      }));

      // Pick primary by completeness
      const primaryId = records
        .map((r) => ({
          id: r.id,
          score: Object.values(r.properties).filter((v) => v && v.length > 0).length,
        }))
        .sort((a, b) => b.score - a.score)[0]?.id;

      if (!primaryId) {
        await db.duplicateGroup.update({
          where: { id: group.id },
          data: {
            status: "failed",
            decidedAt: new Date(),
            errorMessage: "No primary could be chosen",
          },
        });
        await db.scanRun.update({
          where: { id: scanId },
          data: { autoMergeFailedCount: { increment: 1 } },
        });
        continue;
      }

      const result =
        group.objectType === "company"
          ? await executeCompanyMerge(records, primaryId)
          : await executeContactMerge(records, primaryId);

      if (result.ok) {
        await db.duplicateGroup.update({
          where: { id: group.id },
          data: {
            status: "merged",
            primaryId,
            decidedAt: new Date(),
            errorMessage: null,
          },
        });
        await db.scanRun.update({
          where: { id: scanId },
          data: { autoMergedCount: { increment: 1 } },
        });
      } else {
        await db.duplicateGroup.update({
          where: { id: group.id },
          data: {
            status: "failed",
            primaryId,
            decidedAt: new Date(),
            errorMessage: result.error,
          },
        });
        await db.scanRun.update({
          where: { id: scanId },
          data: { autoMergeFailedCount: { increment: 1 } },
        });
      }
    }

    await db.scanRun.update({
      where: { id: scanId },
      data: {
        autoMergeStatus: "complete",
        autoMergeCompletedAt: new Date(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Auto-merge ${scanId} failed:`, err);
    await db.scanRun.update({
      where: { id: scanId },
      data: {
        autoMergeStatus: "failed",
        autoMergeCompletedAt: new Date(),
        autoMergeError: message,
      },
    });
  }
}
