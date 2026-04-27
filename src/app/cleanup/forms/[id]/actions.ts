// Server actions for the form-cleanup review UI.
//
// Default action = "archive" (PATCH archived=true). Reversible.
// Safety model mirrors property + workflow auditors.

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  archiveForm,
  getForm,
  getLatestFormSubmissionAt,
} from "@/lib/hubspot";
import { scoreForm } from "@/lib/cleanup-scoring";
import { isDryRun } from "@/lib/cleanup-types";

export async function acknowledgeForm(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.formFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.$transaction([
      db.formFinding.update({
        where: { id: findingId },
        data: { status: "acknowledged", decidedAt: new Date() },
      }),
      db.suppressedForm.upsert({
        where: { hubspotFormId: finding.hubspotFormId },
        update: { reason: "acknowledged via UI" },
        create: {
          hubspotFormId: finding.hubspotFormId,
          reason: "acknowledged via UI",
        },
      }),
    ]);
    revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function suppressForm(
  findingId: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const finding = await db.formFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "Finding not found" };

  try {
    await db.suppressedForm.upsert({
      where: { hubspotFormId: finding.hubspotFormId },
      update: { reason: reason ?? "suppressed" },
      create: {
        hubspotFormId: finding.hubspotFormId,
        reason: reason ?? "suppressed",
      },
    });
    revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function archiveFormFinding(findingId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const finding = await db.formFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "Finding not found" };
  if (finding.status === "archived") {
    return { ok: false, error: "Already archived" };
  }

  // 1. Re-fetch live state
  let live;
  try {
    live = await getForm(finding.hubspotFormId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const is404 = /(404|not found)/i.test(msg);
    await db.formFinding.update({
      where: { id: findingId },
      data: {
        status: is404 ? "stale" : "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
    return {
      ok: false,
      error: is404 ? "Form already archived/deleted in HubSpot" : msg,
    };
  }

  if (live.archived) {
    await db.formFinding.update({
      where: { id: findingId },
      data: {
        status: "archived",
        decidedAt: new Date(),
        errorMessage: "Already archived in HubSpot when we rechecked",
      },
    });
    revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
    return { ok: true };
  }

  // 2. Re-fetch latest submission & re-score
  let liveSubMs: number | null = null;
  try {
    liveSubMs = await getLatestFormSubmissionAt(finding.hubspotFormId);
  } catch {
    // Non-fatal; fall back to stored value
    liveSubMs = finding.lastSubmittedAt
      ? finding.lastSubmittedAt.getTime()
      : null;
  }
  const lastSubmittedAt = liveSubMs ? new Date(liveSubMs) : null;

  const fieldCount = Array.isArray(live.fieldGroups)
    ? live.fieldGroups.reduce(
        (sum, g) =>
          sum + (Array.isArray(g.fields) ? g.fields.length : 0),
        0
      )
    : 0;

  const rescored = scoreForm({
    name: live.name,
    formType: live.formType,
    createdAt: new Date(live.createdAt),
    updatedAt: new Date(live.updatedAt),
    lastSubmittedAt,
    submissionsSeen: lastSubmittedAt !== null,
    fieldCount,
  });

  if (rescored.recommendation !== "archive") {
    await markStale(
      findingId,
      `live re-score no longer recommends archive (${rescored.recommendation}, score=${rescored.confidence})`
    );
    return {
      ok: false,
      error: `Refused — form state changed since audit. Recommendation is now "${rescored.recommendation}".`,
    };
  }

  // 3. Archive (or dry-run)
  if (isDryRun()) {
    console.log(
      `[DRY_RUN] Would archive form ${finding.hubspotFormId} "${finding.name}"`
    );
    await db.formFinding.update({
      where: { id: findingId },
      data: {
        status: "archived",
        decidedAt: new Date(),
        errorMessage: "[DRY_RUN] not actually archived in HubSpot",
      },
    });
    revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
    return { ok: true };
  }

  try {
    await archiveForm(finding.hubspotFormId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.formFinding.update({
      where: { id: findingId },
      data: {
        status: "failed",
        errorMessage: msg.slice(0, 2000),
        decidedAt: new Date(),
      },
    });
    revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
    return { ok: false, error: msg };
  }

  await db.formFinding.update({
    where: { id: findingId },
    data: { status: "archived", decidedAt: new Date(), errorMessage: null },
  });
  try {
    await db.suppressedForm.upsert({
      where: { hubspotFormId: finding.hubspotFormId },
      update: { reason: "archived" },
      create: { hubspotFormId: finding.hubspotFormId, reason: "archived" },
    });
  } catch {
    // non-fatal
  }

  revalidatePath(`/cleanup/forms/${finding.auditRunId}`);
  return { ok: true };
}

async function markStale(findingId: string, note: string) {
  const f = await db.formFinding.update({
    where: { id: findingId },
    data: { status: "stale", decidedAt: new Date(), errorMessage: note },
  });
  revalidatePath(`/cleanup/forms/${f.auditRunId}`);
}

export async function bulkArchiveFormsHighConfidence(
  auditRunId: string,
  minScore: number = 0.95
): Promise<{ ok: boolean; total: number; error?: string }> {
  const run = await db.formAuditRun.findUnique({ where: { id: auditRunId } });
  if (!run) return { ok: false, total: 0, error: "Audit not found" };

  if (run.bulkArchiveStatus === "running") {
    const startedAt = run.bulkArchiveStartedAt?.getTime() ?? 0;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    if (startedAt > fiveMinAgo) {
      return { ok: false, total: 0, error: "Bulk archive already in progress" };
    }
  }

  const eligible = await db.formFinding.count({
    where: {
      auditRunId,
      status: "pending",
      recommendation: "archive",
      confidence: { gte: minScore },
    },
  });

  if (eligible === 0) return { ok: true, total: 0 };

  await db.formAuditRun.update({
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
  revalidatePath(`/cleanup/forms/${auditRunId}`);
  return { ok: true, total: eligible };
}

async function runBulkArchiveBackground(
  auditRunId: string,
  minScore: number
): Promise<void> {
  try {
    const eligibleIds = await db.formFinding.findMany({
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
      const current = await db.formFinding.findUnique({ where: { id } });
      if (!current || current.status !== "pending") continue;

      const result = await archiveFormFinding(id);
      if (result.ok) archived++;
      else failed++;

      if ((archived + failed) % 5 === 0) {
        await db.formAuditRun.update({
          where: { id: auditRunId },
          data: {
            bulkArchivedCount: archived,
            bulkArchiveFailedCount: failed,
          },
        });
      }
    }

    await db.formAuditRun.update({
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
    console.error(`runBulkArchiveBackground(forms ${auditRunId}) failed:`, e);
    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: {
        bulkArchiveStatus: "failed",
        bulkArchiveError: message.slice(0, 2000),
        bulkArchiveCompletedAt: new Date(),
      },
    });
  }
}
