// Workflow auditor — analog to property-auditor.ts and list-auditor.ts.
//
// Lifecycle:
//   1. init              — status=running, stage=loading_workflows
//   2. loading_workflows — paginateWorkflows() enumerates summaries
//   3. loading_details   — getWorkflowDefinition() per flow (throttled, parallel)
//   4. scoring           — scoreWorkflow() + filter via SuppressedWorkflow
//   5. persisting        — batched create of WorkflowFinding rows
//   6. complete

import { db } from "./db";
import {
  paginateWorkflows,
  getWorkflowDefinition,
  withRetry,
  limit,
  type HubSpotWorkflowSummary,
  type HubSpotWorkflowDetail,
} from "./hubspot";
import { scoreWorkflow, type ScoreWorkflowInput } from "./cleanup-scoring";

export async function runWorkflowAudit(auditRunId: string): Promise<void> {
  try {
    const run = await db.workflowAuditRun.findUnique({
      where: { id: auditRunId },
    });
    if (!run) throw new Error(`WorkflowAuditRun ${auditRunId} not found`);

    await db.workflowAuditRun.update({
      where: { id: auditRunId },
      data: { status: "running", stage: "loading_workflows" },
    });

    // --- 1. Enumerate all workflows (summaries only) ---
    const summaries: HubSpotWorkflowSummary[] = [];
    for await (const page of paginateWorkflows()) {
      summaries.push(...page);
      await db.workflowAuditRun.update({
        where: { id: auditRunId },
        data: { workflowsScanned: summaries.length },
      });
    }

    await db.workflowAuditRun.update({
      where: { id: auditRunId },
      data: {
        stage: "loading_details",
        totalWorkflows: summaries.length,
      },
    });

    // --- 2. Fetch full definitions in parallel (throttled via shared limit) ---
    const details = new Map<string, HubSpotWorkflowDetail>();
    let loaded = 0;
    await Promise.all(
      summaries.map((summary) =>
        limit(async () => {
          try {
            const detail = await withRetry(() => getWorkflowDefinition(summary.id));
            details.set(summary.id, detail);
          } catch (e) {
            // Skip this workflow in findings — log + continue.
            console.error(
              `getWorkflowDefinition(${summary.id}) failed:`,
              e instanceof Error ? e.message : e
            );
          }
          loaded++;
          if (loaded % 10 === 0 || loaded === summaries.length) {
            await db.workflowAuditRun.update({
              where: { id: auditRunId },
              data: { workflowsScanned: loaded },
            });
          }
        })
      )
    );

    // --- 3. Score each + filter suppressed ---
    await db.workflowAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "scoring" },
    });

    const suppressed = await db.suppressedWorkflow.findMany();
    const suppressedIds = new Set(suppressed.map((s) => s.hubspotFlowId));

    type PreparedFinding = {
      hubspotFlowId: string;
      name: string;
      flowType: string;
      objectTypeId: string;
      isEnabled: boolean;
      revisionId: string;
      description: string | null;
      actionCount: number;
      createdAt: Date;
      updatedAt: Date;
      confidence: number;
      recommendation: string;
      status: string;
      reasonJson: string;
      metadataSnapshot: string;
    };

    const findings: PreparedFinding[] = [];
    for (const summary of summaries) {
      if (suppressedIds.has(summary.id)) continue;
      const detail = details.get(summary.id);
      if (!detail) continue; // fetch failed; skip

      const actions = Array.isArray(detail.actions) ? detail.actions : [];
      const createdAt = new Date(detail.createdAt);
      const updatedAt = new Date(detail.updatedAt);

      const input: ScoreWorkflowInput = {
        name: detail.name,
        isEnabled: !!detail.isEnabled,
        createdAt,
        updatedAt,
        revisionId: String(detail.revisionId),
        actionCount: actions.length,
      };

      const result = scoreWorkflow(input);
      const description =
        typeof detail.description === "string" ? detail.description : null;

      findings.push({
        hubspotFlowId: summary.id,
        name: detail.name,
        flowType: detail.flowType,
        objectTypeId: detail.objectTypeId,
        isEnabled: !!detail.isEnabled,
        revisionId: String(detail.revisionId),
        description,
        actionCount: actions.length,
        createdAt,
        updatedAt,
        confidence: result.confidence,
        recommendation: result.recommendation,
        status: "pending",
        reasonJson: JSON.stringify({
          factors: result.factors,
          notes: result.notes,
          version: result.version,
        }),
        metadataSnapshot: JSON.stringify(detail),
      });
    }

    // --- 4. Persist (batched) ---
    await db.workflowAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "persisting" },
    });

    const BATCH = 50;
    for (let i = 0; i < findings.length; i += BATCH) {
      const slice = findings.slice(i, i + BATCH);
      await db.$transaction(
        slice.map((f) =>
          db.workflowFinding.create({
            data: { auditRunId, ...f },
          })
        )
      );
    }

    // --- 5. Mark complete ---
    await db.workflowAuditRun.update({
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
    console.error(`runWorkflowAudit(${auditRunId}) failed:`, err);
    await db.workflowAuditRun.update({
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
