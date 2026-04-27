#!/usr/bin/env -S node --experimental-strip-types
// Weekly HubSpot cleanup orchestrator.
// Runs dedupe scan + auto-merge, then property audit, then list audit.
// Posts ONE unified Slack DM at the end.
//
// Each section runs in its own try/catch — a failure in one doesn't kill the others.
// Review-only in v1: the auditors detect + score but do NOT auto-archive/delete.
// (bulkArchiveHighConfidence / bulkDeleteHighConfidence are server actions the UI
//  calls; the weekly cron leaves them alone until v1.1.)
//
// Invoke via `npm run weekly-cleanup` (configured in package.json).
//
// Env required:
//   HUBSPOT_ACCESS_TOKEN
//   SLACK_BOT_TOKEN
//   SLACK_DM_USER_ID
//   DEDUPE_DASHBOARD_URL  (optional; defaults to http://localhost:3000)

import { db } from "../src/lib/db";
import { runContactScan } from "../src/lib/scanner";
import { runPropertyAudit } from "../src/lib/property-auditor";
import { runListAudit } from "../src/lib/list-auditor";
import { runWorkflowAudit } from "../src/lib/workflow-auditor";
import { runFormAudit } from "../src/lib/form-auditor";
import {
  executeContactMerge,
  executeCompanyMerge,
  type ContactRecord,
} from "../src/lib/merge";
import {
  postSlackDM,
  buildWeeklyCleanupSummary,
  type DedupeSection,
  type PropertyAuditSection,
  type ListAuditSection,
  type WorkflowAuditSection,
  type FormAuditSection,
} from "../src/lib/slack";
import {
  PROPERTY_SCORING_VERSION,
  PROPERTY_RECOMMENDATION_THRESHOLDS,
  LIST_SCORING_VERSION,
  LIST_RECOMMENDATION_THRESHOLDS,
  WORKFLOW_SCORING_VERSION,
  WORKFLOW_RECOMMENDATION_THRESHOLDS,
  FORM_SCORING_VERSION,
  FORM_RECOMMENDATION_THRESHOLDS,
} from "../src/lib/cleanup-types";

const DASHBOARD_URL_BASE =
  process.env.DEDUPE_DASHBOARD_URL ?? "http://localhost:3000";
const AUTO_MERGE_MIN_SCORE = 0.99;

async function main() {
  const runStartedAt = new Date();
  console.log(`[weekly-cleanup] starting @ ${runStartedAt.toISOString()}`);

  const dedupe = await runDedupeSection();
  const properties = await runPropertySection();
  const lists = await runListSection();
  const workflows = await runWorkflowSection();
  const forms = await runFormSection();

  const summary = buildWeeklyCleanupSummary({
    runStartedAt,
    dedupe,
    properties,
    lists,
    workflows,
    forms,
  });
  const slackRes = await postSlackDM(summary);
  if (!slackRes.ok) {
    console.error(`[weekly-cleanup] Slack post failed: ${slackRes.error}`);
  } else {
    console.log("[weekly-cleanup] Slack DM sent");
  }
  console.log("[weekly-cleanup] done");
  process.exit(0);
}

// ============================================================
// Dedupe section (ports the logic from weekly-dedupe.ts)
// ============================================================

async function runDedupeSection(): Promise<DedupeSection> {
  console.log("[weekly-cleanup] → dedupe");
  let scanId: string | undefined;
  try {
    const scanRun = await db.scanRun.create({
      data: {
        objectType: "contact",
        status: "queued",
        ruleSet: JSON.stringify({
          scheduled: true,
          source: "weekly-cleanup",
          autoMergeMinScore: AUTO_MERGE_MIN_SCORE,
        }),
      },
    });
    scanId = scanRun.id;

    await runContactScan(scanId);
    const scanFinal = await db.scanRun.findUnique({ where: { id: scanId } });
    if (!scanFinal) throw new Error("Scan disappeared after completion");
    if (scanFinal.status !== "complete") {
      throw new Error(`Scan failed: ${scanFinal.error ?? "unknown"}`);
    }

    // Auto-merge high-confidence groups (inline, to surface counters to scanRun row)
    const eligibleGroups = await db.duplicateGroup.findMany({
      where: {
        scanRunId: scanId,
        status: "pending",
        matchScore: { gte: AUTO_MERGE_MIN_SCORE },
      },
      include: { members: true },
      orderBy: { matchScore: "desc" },
    });

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
      const primaryId = records
        .map((r) => ({
          id: r.id,
          score: Object.values(r.properties).filter((v) => v && v.length > 0).length,
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

    const pendingReview = await db.duplicateGroup.count({
      where: { scanRunId: scanId, status: "pending" },
    });

    console.log(
      `[weekly-cleanup] dedupe: ${scanFinal.groupsFound} groups found, ${merged} merged, ${failed} failed, ${pendingReview} need review`
    );

    return {
      status: "ok",
      scanId,
      recordsScanned: scanFinal.recordsScanned,
      groupsFound: scanFinal.groupsFound,
      autoMerged: merged,
      autoMergeFailed: failed,
      pendingReview,
      dashboardUrl: `${DASHBOARD_URL_BASE}/scan/${scanId}?filter=pending`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly-cleanup] dedupe FAILED: ${message}`);
    return {
      status: "failed",
      scanId,
      error: message,
      dashboardUrl: scanId ? `${DASHBOARD_URL_BASE}/scan/${scanId}` : undefined,
    };
  }
}

// ============================================================
// Property audit section
// ============================================================

async function runPropertySection(): Promise<PropertyAuditSection> {
  console.log("[weekly-cleanup] → properties");
  let auditId: string | undefined;
  try {
    const run = await db.propertyAuditRun.create({
      data: {
        objectTypes: JSON.stringify(["contacts", "companies", "deals"]),
        status: "queued",
        ruleSet: JSON.stringify({
          scheduled: true,
          source: "weekly-cleanup",
          kind: "property-audit",
          version: PROPERTY_SCORING_VERSION,
          thresholds: PROPERTY_RECOMMENDATION_THRESHOLDS,
        }),
      },
    });
    auditId = run.id;

    await runPropertyAudit(auditId);
    const final = await db.propertyAuditRun.findUnique({ where: { id: auditId } });
    if (!final) throw new Error("Audit disappeared after completion");
    if (final.status !== "complete") {
      throw new Error(`Property audit failed: ${final.error ?? "unknown"}`);
    }

    const [archiveReady, review, keep] = await Promise.all([
      db.propertyFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "archive" },
      }),
      db.propertyFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "review" },
      }),
      db.propertyFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "keep" },
      }),
    ]);

    console.log(
      `[weekly-cleanup] properties: ${final.totalProperties} scanned, ${archiveReady} archive-ready, ${review} review`
    );

    return {
      status: "ok",
      auditId,
      totalProperties: final.totalProperties ?? 0,
      archiveReady,
      review,
      keep,
      dashboardUrl: `${DASHBOARD_URL_BASE}/cleanup/properties/${auditId}?filter=archive-ready`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly-cleanup] properties FAILED: ${message}`);
    return {
      status: "failed",
      auditId,
      error: message,
      dashboardUrl: auditId
        ? `${DASHBOARD_URL_BASE}/cleanup/properties/${auditId}`
        : undefined,
    };
  }
}

// ============================================================
// List audit section
// ============================================================

async function runListSection(): Promise<ListAuditSection> {
  console.log("[weekly-cleanup] → lists");
  let auditId: string | undefined;
  try {
    const run = await db.listAuditRun.create({
      data: {
        status: "queued",
        ruleSet: JSON.stringify({
          scheduled: true,
          source: "weekly-cleanup",
          kind: "list-audit",
          version: LIST_SCORING_VERSION,
          thresholds: LIST_RECOMMENDATION_THRESHOLDS,
        }),
      },
    });
    auditId = run.id;

    await runListAudit(auditId);
    const final = await db.listAuditRun.findUnique({ where: { id: auditId } });
    if (!final) throw new Error("Audit disappeared after completion");
    if (final.status !== "complete") {
      throw new Error(`List audit failed: ${final.error ?? "unknown"}`);
    }

    const [deleteReady, review, keep] = await Promise.all([
      db.listFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "delete" },
      }),
      db.listFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "review" },
      }),
      db.listFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "keep" },
      }),
    ]);

    console.log(
      `[weekly-cleanup] lists: ${final.totalLists} scanned, ${deleteReady} delete-ready, ${review} review`
    );

    return {
      status: "ok",
      auditId,
      totalLists: final.totalLists ?? 0,
      deleteReady,
      review,
      keep,
      dashboardUrl: `${DASHBOARD_URL_BASE}/cleanup/lists/${auditId}?filter=delete-ready`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly-cleanup] lists FAILED: ${message}`);
    return {
      status: "failed",
      auditId,
      error: message,
      dashboardUrl: auditId
        ? `${DASHBOARD_URL_BASE}/cleanup/lists/${auditId}`
        : undefined,
    };
  }
}

// ============================================================
// Workflow audit section
// ============================================================

async function runWorkflowSection(): Promise<WorkflowAuditSection> {
  console.log("[weekly-cleanup] → workflows");
  let auditId: string | undefined;
  try {
    const run = await db.workflowAuditRun.create({
      data: {
        status: "queued",
        ruleSet: JSON.stringify({
          scheduled: true,
          source: "weekly-cleanup",
          kind: "workflow-audit",
          version: WORKFLOW_SCORING_VERSION,
          thresholds: WORKFLOW_RECOMMENDATION_THRESHOLDS,
        }),
      },
    });
    auditId = run.id;

    await runWorkflowAudit(auditId);
    const final = await db.workflowAuditRun.findUnique({ where: { id: auditId } });
    if (!final) throw new Error("Audit disappeared after completion");
    if (final.status !== "complete") {
      throw new Error(`Workflow audit failed: ${final.error ?? "unknown"}`);
    }

    const [disableReady, review, keep] = await Promise.all([
      db.workflowFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "disable" },
      }),
      db.workflowFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "review" },
      }),
      db.workflowFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "keep" },
      }),
    ]);

    console.log(
      `[weekly-cleanup] workflows: ${final.totalWorkflows} scanned, ${disableReady} disable-ready, ${review} review`
    );

    return {
      status: "ok",
      auditId,
      totalWorkflows: final.totalWorkflows ?? 0,
      disableReady,
      review,
      keep,
      dashboardUrl: `${DASHBOARD_URL_BASE}/cleanup/workflows/${auditId}?filter=disable-ready`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly-cleanup] workflows FAILED: ${message}`);
    return {
      status: "failed",
      auditId,
      error: message,
      dashboardUrl: auditId
        ? `${DASHBOARD_URL_BASE}/cleanup/workflows/${auditId}`
        : undefined,
    };
  }
}

// ============================================================
// Form audit section
// ============================================================

async function runFormSection(): Promise<FormAuditSection> {
  console.log("[weekly-cleanup] → forms");
  let auditId: string | undefined;
  try {
    const run = await db.formAuditRun.create({
      data: {
        status: "queued",
        ruleSet: JSON.stringify({
          scheduled: true,
          source: "weekly-cleanup",
          kind: "form-audit",
          version: FORM_SCORING_VERSION,
          thresholds: FORM_RECOMMENDATION_THRESHOLDS,
        }),
      },
    });
    auditId = run.id;

    await runFormAudit(auditId);
    const final = await db.formAuditRun.findUnique({ where: { id: auditId } });
    if (!final) throw new Error("Audit disappeared after completion");
    if (final.status !== "complete") {
      throw new Error(`Form audit failed: ${final.error ?? "unknown"}`);
    }

    const [archiveReady, review, keep] = await Promise.all([
      db.formFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "archive" },
      }),
      db.formFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "review" },
      }),
      db.formFinding.count({
        where: { auditRunId: auditId, status: "pending", recommendation: "keep" },
      }),
    ]);

    console.log(
      `[weekly-cleanup] forms: ${final.totalForms} scanned, ${archiveReady} archive-ready, ${review} review`
    );

    return {
      status: "ok",
      auditId,
      totalForms: final.totalForms ?? 0,
      archiveReady,
      review,
      keep,
      dashboardUrl: `${DASHBOARD_URL_BASE}/cleanup/forms/${auditId}?filter=archive-ready`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly-cleanup] forms FAILED: ${message}`);
    return {
      status: "failed",
      auditId,
      error: message,
      dashboardUrl: auditId
        ? `${DASHBOARD_URL_BASE}/cleanup/forms/${auditId}`
        : undefined,
    };
  }
}

main().catch((err) => {
  console.error("[weekly-cleanup] UNCAUGHT:", err);
  process.exit(1);
});
