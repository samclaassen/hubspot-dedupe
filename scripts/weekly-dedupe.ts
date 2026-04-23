#!/usr/bin/env -S node --experimental-strip-types
// Weekly dedupe orchestrator. Intended to be invoked by launchd every Sunday 2am.
//
// Flow:
//   1. Create a ScanRun
//   2. Run the contact scanner end-to-end (pagination + detection + filter + persist)
//   3. Run auto-merge for all groups with score >= 0.99
//   4. Post a Slack DM summary
//
// This script is designed to run standalone — no Next.js server needed.
// Invoke via `npm run weekly-dedupe`.

import { db } from "../src/lib/db";
import { runContactScan } from "../src/lib/scanner";
import {
  executeContactMerge,
  executeCompanyMerge,
  type ContactRecord,
} from "../src/lib/merge";
import {
  postSlackDM,
  buildWeeklyDedupeSummary,
} from "../src/lib/slack";

const DASHBOARD_URL_BASE =
  process.env.DEDUPE_DASHBOARD_URL ?? "http://localhost:3000";
const AUTO_MERGE_MIN_SCORE = 0.99;

async function main() {
  console.log("[weekly-dedupe] starting…");

  // 1. Create the ScanRun
  const scanRun = await db.scanRun.create({
    data: {
      objectType: "contact",
      status: "queued",
      ruleSet: JSON.stringify({
        scheduled: true,
        source: "weekly-dedupe",
        autoMergeMinScore: AUTO_MERGE_MIN_SCORE,
      }),
    },
  });
  const scanId = scanRun.id;
  console.log(`[weekly-dedupe] scan id: ${scanId}`);

  try {
    // 2. Run the scan (blocking call — we await completion)
    await runContactScan(scanId);

    // Re-fetch the scan row to get final counts
    const scanFinal = await db.scanRun.findUnique({ where: { id: scanId } });
    if (!scanFinal) throw new Error("Scan disappeared after completion");
    if (scanFinal.status !== "complete") {
      throw new Error(`Scan failed: ${scanFinal.error ?? "unknown"}`);
    }
    const groupsFound = scanFinal.groupsFound;
    console.log(`[weekly-dedupe] scan complete: ${groupsFound} groups found`);

    // Count how many groups were filtered out by SuppressedPair table.
    // We can approximate by counting suppressed pairs relevant to this scan,
    // but for the notification we just want to tell the user "N suppressed
    // pairs were skipped" — so count total suppressed pairs.
    const skippedSuppressed = await db.suppressedPair.count({
      where: { objectType: "contact" },
    });

    // 3. Auto-merge all groups with score >= 0.99
    const eligibleGroups = await db.duplicateGroup.findMany({
      where: {
        scanRunId: scanId,
        status: "pending",
        matchScore: { gte: AUTO_MERGE_MIN_SCORE },
      },
      include: { members: true },
      orderBy: { matchScore: "desc" },
    });
    console.log(
      `[weekly-dedupe] auto-merging ${eligibleGroups.length} eligible groups…`
    );

    // Mark scan as auto-merging so the dashboard shows progress
    await db.scanRun.update({
      where: { id: scanId },
      data: {
        autoMergeStatus: "running",
        autoMergeTotal: eligibleGroups.length,
        autoMergedCount: 0,
        autoMergeFailedCount: 0,
        autoMergeStartedAt: new Date(),
      },
    });

    let merged = 0;
    let failed = 0;
    for (const group of eligibleGroups) {
      const records: ContactRecord[] = group.members.map((m) => ({
        id: m.hubspotId,
        properties: JSON.parse(m.propertiesSnapshot) as Record<
          string,
          string | null
        >,
      }));
      // Pick primary by most-complete (same heuristic as the UI default)
      const primaryId = records
        .map((r) => ({
          id: r.id,
          score: Object.values(r.properties).filter((v) => v && v.length > 0)
            .length,
        }))
        .sort((a, b) => b.score - a.score)[0]?.id;

      if (!primaryId) {
        failed++;
        await db.duplicateGroup.update({
          where: { id: group.id },
          data: {
            status: "failed",
            decidedAt: new Date(),
            errorMessage: "No primary could be chosen",
          },
        });
        continue;
      }

      const result =
        group.objectType === "company"
          ? await executeCompanyMerge(records, primaryId)
          : await executeContactMerge(records, primaryId);

      if (result.ok) {
        merged++;
        await db.duplicateGroup.update({
          where: { id: group.id },
          data: {
            status: "merged",
            primaryId,
            decidedAt: new Date(),
            errorMessage: null,
          },
        });
      } else {
        failed++;
        await db.duplicateGroup.update({
          where: { id: group.id },
          data: {
            status: "failed",
            primaryId,
            decidedAt: new Date(),
            errorMessage: result.error,
          },
        });
      }

      // Update the ScanRun counters every iteration so the dashboard's
      // polling banner stays fresh.
      await db.scanRun.update({
        where: { id: scanId },
        data: { autoMergedCount: merged, autoMergeFailedCount: failed },
      });
    }

    await db.scanRun.update({
      where: { id: scanId },
      data: {
        autoMergeStatus: "complete",
        autoMergeCompletedAt: new Date(),
      },
    });

    console.log(
      `[weekly-dedupe] auto-merge done: ${merged} merged, ${failed} failed`
    );

    // 4. Count the final "needs review" groups (pending with score < 0.99
    // OR pending + merge attempt failed)
    const pendingReview = await db.duplicateGroup.count({
      where: { scanRunId: scanId, status: "pending" },
    });

    // 5. Post Slack summary
    const summary = buildWeeklyDedupeSummary({
      scanId,
      scanStartedAt: scanFinal.startedAt,
      recordsScanned: scanFinal.recordsScanned,
      groupsFound,
      autoMerged: merged,
      autoMergeFailed: failed,
      pendingReview,
      skippedSuppressed,
      dashboardUrl: `${DASHBOARD_URL_BASE}/scan/${scanId}?filter=pending`,
    });
    const slackRes = await postSlackDM(summary);
    if (!slackRes.ok) {
      console.error(`[weekly-dedupe] Slack post failed: ${slackRes.error}`);
    } else {
      console.log("[weekly-dedupe] Slack DM sent");
    }
    console.log("[weekly-dedupe] done");
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[weekly-dedupe] FATAL:", err);
    // Best-effort Slack notification about failure
    try {
      const errorSummary = buildWeeklyDedupeSummary({
        scanId,
        scanStartedAt: scanRun.startedAt,
        recordsScanned: 0,
        groupsFound: 0,
        autoMerged: 0,
        autoMergeFailed: 0,
        pendingReview: 0,
        skippedSuppressed: 0,
        dashboardUrl: `${DASHBOARD_URL_BASE}/scan/${scanId}`,
        error: message,
      });
      await postSlackDM(errorSummary);
    } catch {
      // swallow — we're already in the error path
    }
    process.exit(1);
  }
}

main();
