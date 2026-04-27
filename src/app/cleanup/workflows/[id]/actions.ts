// Server actions for the workflow-cleanup review UI.
//
// v1 default action is "disable" (PUT isEnabled=false). Reversible.
// Hard delete is intentionally NOT exposed in v1 — HubSpot's delete requires
// their Support team to recover, so we keep that out of reach until v1.2+.
//
// Safety model:
//   1. Re-fetch the live workflow immediately before disabling.
//   2. Re-score; refuse if recommendation is no longer "disable".
//   3. No-op if already disabled.
//   4. DRY_RUN=true turns disable into a log-only no-op.

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { disableWorkflow, getWorkflowDefinition } from "@/lib/hubspot";
import { scoreWorkflow } from "@/lib/cleanup-scoring";
import { isDryRun } from "@/lib/cleanup-types";

export async function acknowledgeWorkflow(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.workflowFinding.findUnique({
    where: { id: findingId },
  });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.$transaction([
      db.workflowFinding.update({
        where: { id: findingId },
        data: { status: "acknowledged", decidedAt: new Date() },
      }),
      db.suppressedWorkflow.upsert({
        where: { hubspotFlowId: finding.hubspotFlowId },
        update: { reason: "acknowledged via UI" },
        create: {
          hubspotFlowId: finding.hubspotFlowId,
          reason: "acknowledged via UI",
        },
      }),
    ]);
    revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function suppressWorkflow(
  findingId: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const finding = await db.workflowFinding.findUnique({
    where: { id: findingId },
  });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.suppressedWorkflow.upsert({
      where: { hubspotFlowId: finding.hubspotFlowId },
      update: { reason: reason ?? "suppressed" },
      create: {
        hubspotFlowId: finding.hubspotFlowId,
        reason: reason ?? "suppressed",
      },
    });
    revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disableWorkflowFinding(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.workflowFinding.findUnique({
    where: { id: findingId },
  });
  if (!finding) return { ok: false, error: "Finding not found" };
  if (finding.status === "disabled") {
    return { ok: false, error: "Already disabled" };
  }

  // 1. Re-fetch live state.
  let live;
  try {
    live = await getWorkflowDefinition(finding.hubspotFlowId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const is404 = /(404|not found)/i.test(msg);
    await db.workflowFinding.update({
      where: { id: findingId },
      data: {
        status: is404 ? "stale" : "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
    return {
      ok: false,
      error: is404 ? "Workflow already deleted in HubSpot" : msg,
    };
  }

  // 2. No-op if already disabled by someone else.
  if (!live.isEnabled) {
    await db.workflowFinding.update({
      where: { id: findingId },
      data: {
        status: "disabled",
        decidedAt: new Date(),
        errorMessage: "Already disabled in HubSpot when we rechecked",
      },
    });
    revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
    return { ok: true };
  }

  // 3. Re-score with live data.
  const actions = Array.isArray(live.actions) ? live.actions : [];
  const rescored = scoreWorkflow({
    name: live.name,
    isEnabled: !!live.isEnabled,
    createdAt: new Date(live.createdAt),
    updatedAt: new Date(live.updatedAt),
    revisionId: String(live.revisionId),
    actionCount: actions.length,
  });
  if (rescored.recommendation !== "disable") {
    await markStale(
      findingId,
      `live re-score no longer recommends disable (${rescored.recommendation}, score=${rescored.confidence})`
    );
    return {
      ok: false,
      error: `Refused — workflow state changed since audit. Recommendation is now "${rescored.recommendation}".`,
    };
  }

  // 4. Disable (or dry-run).
  if (isDryRun()) {
    console.log(
      `[DRY_RUN] Would disable workflow ${finding.hubspotFlowId} "${finding.name}"`
    );
    await db.workflowFinding.update({
      where: { id: findingId },
      data: {
        status: "disabled",
        decidedAt: new Date(),
        errorMessage: "[DRY_RUN] not actually disabled in HubSpot",
      },
    });
    revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
    return { ok: true };
  }

  try {
    await disableWorkflow(finding.hubspotFlowId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.workflowFinding.update({
      where: { id: findingId },
      data: {
        status: "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
    return { ok: false, error: msg };
  }

  // 5. Mark disabled + suppress future audits
  await db.workflowFinding.update({
    where: { id: findingId },
    data: { status: "disabled", decidedAt: new Date(), errorMessage: null },
  });
  try {
    await db.suppressedWorkflow.upsert({
      where: { hubspotFlowId: finding.hubspotFlowId },
      update: { reason: "disabled" },
      create: { hubspotFlowId: finding.hubspotFlowId, reason: "disabled" },
    });
  } catch {
    // non-fatal
  }

  revalidatePath(`/cleanup/workflows/${finding.auditRunId}`);
  return { ok: true };
}

async function markStale(findingId: string, note: string) {
  const f = await db.workflowFinding.update({
    where: { id: findingId },
    data: {
      status: "stale",
      decidedAt: new Date(),
      errorMessage: note,
    },
  });
  revalidatePath(`/cleanup/workflows/${f.auditRunId}`);
}

export async function bulkDisableHighConfidence(
  auditRunId: string,
  minScore: number = 0.95
): Promise<{ ok: boolean; total: number; error?: string }> {
  const run = await db.workflowAuditRun.findUnique({ where: { id: auditRunId } });
  if (!run) return { ok: false, total: 0, error: "Audit not found" };

  if (run.bulkDisableStatus === "running") {
    const startedAt = run.bulkDisableStartedAt?.getTime() ?? 0;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    if (startedAt > fiveMinAgo) {
      return { ok: false, total: 0, error: "Bulk disable already in progress" };
    }
  }

  const eligible = await db.workflowFinding.count({
    where: {
      auditRunId,
      status: "pending",
      recommendation: "disable",
      confidence: { gte: minScore },
    },
  });

  if (eligible === 0) return { ok: true, total: 0 };

  await db.workflowAuditRun.update({
    where: { id: auditRunId },
    data: {
      bulkDisableStatus: "running",
      bulkDisableMinScore: minScore,
      bulkDisableTotal: eligible,
      bulkDisabledCount: 0,
      bulkDisableFailedCount: 0,
      bulkDisableStartedAt: new Date(),
      bulkDisableCompletedAt: null,
      bulkDisableError: null,
    },
  });

  void runBulkDisableBackground(auditRunId, minScore);
  revalidatePath(`/cleanup/workflows/${auditRunId}`);
  return { ok: true, total: eligible };
}

async function runBulkDisableBackground(
  auditRunId: string,
  minScore: number
): Promise<void> {
  try {
    const eligibleIds = await db.workflowFinding.findMany({
      where: {
        auditRunId,
        status: "pending",
        recommendation: "disable",
        confidence: { gte: minScore },
      },
      select: { id: true },
      orderBy: { confidence: "desc" },
    });

    let disabled = 0;
    let failed = 0;

    for (const { id } of eligibleIds) {
      const current = await db.workflowFinding.findUnique({ where: { id } });
      if (!current || current.status !== "pending") continue;

      const result = await disableWorkflowFinding(id);
      if (result.ok) disabled++;
      else failed++;

      if ((disabled + failed) % 5 === 0) {
        await db.workflowAuditRun.update({
          where: { id: auditRunId },
          data: {
            bulkDisabledCount: disabled,
            bulkDisableFailedCount: failed,
          },
        });
      }
    }

    await db.workflowAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkDisableStatus: "complete",
        bulkDisabledCount: disabled,
        bulkDisableFailedCount: failed,
        bulkDisableCompletedAt: new Date(),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`runBulkDisableBackground(${auditRunId}) failed:`, e);
    await db.workflowAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkDisableStatus: "failed",
        bulkDisableError: message.slice(0, 2000),
        bulkDisableCompletedAt: new Date(),
      },
    });
  }
}
