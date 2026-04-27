// Form auditor — analog to list-auditor.ts + workflow-auditor.ts.
//
// Lifecycle:
//   1. init                — status=running, stage=loading_forms
//   2. loading_forms       — paginateForms() enumerates all non-archived forms
//   3. loading_submissions — getLatestFormSubmissionAt() per form (throttled)
//   4. scoring             — scoreForm() + filter SuppressedForm
//   5. persisting          — batched create of FormFinding rows
//   6. complete

import { db } from "./db";
import {
  paginateForms,
  getLatestFormSubmissionAt,
  withRetry,
  limit,
  type HubSpotForm,
} from "./hubspot";
import { scoreForm, type ScoreFormInput } from "./cleanup-scoring";

export async function runFormAudit(auditRunId: string): Promise<void> {
  try {
    const run = await db.formAuditRun.findUnique({ where: { id: auditRunId } });
    if (!run) throw new Error(`FormAuditRun ${auditRunId} not found`);

    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: { status: "running", stage: "loading_forms" },
    });

    // --- 1. Enumerate all forms ---
    const forms: HubSpotForm[] = [];
    for await (const page of paginateForms()) {
      forms.push(...page);
      await db.formAuditRun.update({
        where: { id: auditRunId },
        data: { formsScanned: forms.length },
      });
    }

    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: {
        stage: "loading_submissions",
        totalForms: forms.length,
      },
    });

    // --- 2. Fetch latest-submission timestamps in parallel (throttled) ---
    const lastSubMs = new Map<string, number | null>();
    let loaded = 0;
    await Promise.all(
      forms.map((form) =>
        limit(async () => {
          try {
            const ms = await withRetry(() => getLatestFormSubmissionAt(form.id));
            lastSubMs.set(form.id, ms);
          } catch (e) {
            // Submission fetch failure isn't fatal — mark null (treat as never-submitted)
            lastSubMs.set(form.id, null);
            console.error(
              `getLatestFormSubmissionAt(${form.id}) failed:`,
              e instanceof Error ? e.message : e
            );
          }
          loaded++;
          if (loaded % 10 === 0 || loaded === forms.length) {
            await db.formAuditRun.update({
              where: { id: auditRunId },
              data: { formsScanned: loaded },
            });
          }
        })
      )
    );

    // --- 3. Score + filter suppressed ---
    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "scoring" },
    });

    const suppressed = await db.suppressedForm.findMany();
    const suppressedIds = new Set(suppressed.map((s) => s.hubspotFormId));

    type PreparedFinding = {
      hubspotFormId: string;
      name: string;
      formType: string;
      fieldCount: number;
      createdAt: Date;
      updatedAt: Date;
      lastSubmittedAt: Date | null;
      submissionsSeen: boolean;
      confidence: number;
      recommendation: string;
      status: string;
      reasonJson: string;
      metadataSnapshot: string;
    };

    const findings: PreparedFinding[] = [];
    for (const form of forms) {
      if (suppressedIds.has(form.id)) continue;

      const createdAt = new Date(form.createdAt);
      const updatedAt = new Date(form.updatedAt);
      const ms = lastSubMs.get(form.id) ?? null;
      const lastSubmittedAt = ms ? new Date(ms) : null;

      // Flatten fields from the fieldGroups structure
      const fieldCount = Array.isArray(form.fieldGroups)
        ? form.fieldGroups.reduce(
            (sum, g) => sum + (Array.isArray(g.fields) ? g.fields.length : 0),
            0
          )
        : 0;

      const input: ScoreFormInput = {
        name: form.name,
        formType: form.formType,
        createdAt,
        updatedAt,
        lastSubmittedAt,
        submissionsSeen: lastSubmittedAt !== null,
        fieldCount,
      };

      const result = scoreForm(input);

      findings.push({
        hubspotFormId: form.id,
        name: form.name,
        formType: form.formType,
        fieldCount,
        createdAt,
        updatedAt,
        lastSubmittedAt,
        submissionsSeen: input.submissionsSeen,
        confidence: result.confidence,
        recommendation: result.recommendation,
        status: "pending",
        reasonJson: JSON.stringify({
          factors: result.factors,
          notes: result.notes,
          version: result.version,
        }),
        metadataSnapshot: JSON.stringify(form),
      });
    }

    // --- 4. Persist ---
    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "persisting" },
    });

    const BATCH = 50;
    for (let i = 0; i < findings.length; i += BATCH) {
      const slice = findings.slice(i, i + BATCH);
      await db.$transaction(
        slice.map((f) =>
          db.formFinding.create({
            data: { auditRunId, ...f },
          })
        )
      );
    }

    // --- 5. Mark complete ---
    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: {
        status: "complete",
        stage: null,
        completedAt: new Date(),
        findingsCount: findings.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`runFormAudit(${auditRunId}) failed:`, err);
    await db.formAuditRun.update({
      where: { id: auditRunId },
      data: {
        status: "failed",
        stage: null,
        completedAt: new Date(),
        error: message.slice(0, 2000),
      },
    });
  }
}
