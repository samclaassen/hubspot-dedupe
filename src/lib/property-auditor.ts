// Property auditor — analog to src/lib/scanner.ts for the dedup tool.
//
// Lifecycle (mirrors runContactScan):
//   1. init            — status=running, stage=loading_properties
//   2. loading_properties — listProperties() for each requested object type
//   3. counting        — countRecordsWithProperty() for each property
//   4. loading_workflows — paginateWorkflows() + getWorkflowDefinition() per flow
//   5. scoring         — scoreProperty() + workflow substring-search per finding
//   6. persisting      — filter suppressed, batched create of PropertyFinding rows
//   7. complete        — status=complete, findingsCount=N

import { db } from "./db";
import {
  listProperties,
  countRecordsWithProperty,
  getContactsTotal,
  getCompaniesTotal,
  getDealsTotal,
  paginateWorkflows,
  getWorkflowDefinition,
  withRetry,
  limit,
  type SupportedAuditObjectType,
  type HubSpotProperty,
  type HubSpotWorkflowDetail,
} from "./hubspot";
import { scoreProperty, type ScorePropertyInput } from "./cleanup-scoring";
import type { AuditObjectType } from "./cleanup-types";

type AuditedProperty = {
  objectType: AuditObjectType;
  property: HubSpotProperty;
  populatedCount: number;
  recordBase: number;
};

type WorkflowReferenceIndex = {
  // flowId -> stringified definition (lowercased for case-insensitive search)
  byFlow: Map<string, string>;
  // flowId -> human name (for finding display)
  flowNames: Map<string, string>;
};

export async function runPropertyAudit(auditRunId: string): Promise<void> {
  try {
    const run = await db.propertyAuditRun.findUnique({
      where: { id: auditRunId },
    });
    if (!run) throw new Error(`PropertyAuditRun ${auditRunId} not found`);

    const objectTypes = JSON.parse(run.objectTypes) as AuditObjectType[];
    if (objectTypes.length === 0) {
      throw new Error("No object types selected for audit");
    }

    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: { status: "running", stage: "loading_properties" },
    });

    // --- 1. Load properties for each object type ---
    const audited: AuditedProperty[] = [];
    for (const objectType of objectTypes) {
      const props = await listProperties(objectType);
      const base = await fetchRecordBase(objectType);
      for (const p of props) {
        audited.push({
          objectType,
          property: p,
          populatedCount: 0, // filled in next stage
          recordBase: base,
        });
      }
    }

    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: {
        stage: "counting",
        totalProperties: audited.length,
      },
    });

    // --- 2. Count populated records per property (throttled via limit) ---
    let completed = 0;
    const BATCH_PROGRESS = 10; // update DB every 10 properties
    await Promise.all(
      audited.map((item) =>
        limit(async () => {
          try {
            item.populatedCount = await countRecordsWithProperty(
              item.objectType,
              item.property.name
            );
          } catch (e) {
            // A single property count failure shouldn't kill the audit.
            // Set -1 to flag "count unknown" and continue.
            item.populatedCount = -1;
            console.error(
              `countRecordsWithProperty failed for ${item.objectType}.${item.property.name}:`,
              e instanceof Error ? e.message : e
            );
          }
          completed++;
          if (completed % BATCH_PROGRESS === 0 || completed === audited.length) {
            await db.propertyAuditRun.update({
              where: { id: auditRunId },
              data: { propertiesScanned: completed },
            });
          }
        })
      )
    );

    // --- 3. Load workflows (shared snapshot for substring-search) ---
    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "loading_workflows" },
    });

    const workflowIndex = await buildWorkflowIndex();

    // --- 4. Score + prepare findings ---
    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "scoring" },
    });

    const suppressed = await db.suppressedProperty.findMany();
    const suppressedKeys = new Set(
      suppressed.map((s) => `${s.objectType}::${s.propertyName}`)
    );

    type PreparedFinding = {
      objectType: string;
      propertyName: string;
      propertyLabel: string;
      propertyGroupName: string | null;
      fieldType: string;
      dataType: string;
      populatedCount: number;
      recordBase: number;
      hasFormula: boolean;
      hubspotDefined: boolean;
      archivable: boolean;
      hidden: boolean;
      formField: boolean;
      referencedInWorkflows: number;
      workflowIdsJson: string | null;
      lastModifiedAt: Date | null;
      confidence: number;
      recommendation: string;
      status: string;
      reasonJson: string;
      metadataSnapshot: string;
    };

    const findings: PreparedFinding[] = [];
    for (const item of audited) {
      const key = `${item.objectType}::${item.property.name}`;
      if (suppressedKeys.has(key)) continue;

      const { referencedFlowIds } = findWorkflowReferences(
        workflowIndex,
        item.property.name
      );

      const input: ScorePropertyInput = {
        hubspotDefined: !!item.property.hubspotDefined,
        archivable: item.property.modificationMetadata?.archivable ?? true,
        hidden: !!item.property.hidden,
        formField: !!item.property.formField,
        hasFormula: !!item.property.calculationFormula,
        lastModifiedAt: item.property.updatedAt
          ? new Date(item.property.updatedAt)
          : null,
        populatedCount: Math.max(item.populatedCount, 0),
        recordBase: item.recordBase,
        referencedInWorkflows: referencedFlowIds.length,
      };

      const result = scoreProperty(input);

      findings.push({
        objectType: item.objectType,
        propertyName: item.property.name,
        propertyLabel: item.property.label ?? item.property.name,
        propertyGroupName: item.property.groupName ?? null,
        fieldType: item.property.fieldType ?? "",
        dataType: item.property.type ?? "",
        populatedCount: item.populatedCount,
        recordBase: item.recordBase,
        hasFormula: !!item.property.calculationFormula,
        hubspotDefined: !!item.property.hubspotDefined,
        archivable: item.property.modificationMetadata?.archivable ?? true,
        hidden: !!item.property.hidden,
        formField: !!item.property.formField,
        referencedInWorkflows: referencedFlowIds.length,
        workflowIdsJson:
          referencedFlowIds.length > 0
            ? JSON.stringify(
                referencedFlowIds.map((id) => ({
                  id,
                  name: workflowIndex.flowNames.get(id) ?? null,
                }))
              )
            : null,
        lastModifiedAt: input.lastModifiedAt,
        confidence: result.confidence,
        recommendation: result.recommendation,
        status: "pending",
        reasonJson: JSON.stringify({
          factors: result.factors,
          notes: result.notes,
          version: result.version,
        }),
        metadataSnapshot: JSON.stringify(item.property),
      });
    }

    // --- 5. Persist findings (batched) ---
    await db.propertyAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "persisting" },
    });

    const BATCH = 50;
    for (let i = 0; i < findings.length; i += BATCH) {
      const slice = findings.slice(i, i + BATCH);
      await db.$transaction(
        slice.map((f) =>
          db.propertyFinding.create({
            data: { auditRunId, ...f },
          })
        )
      );
    }

    // --- 6. Mark complete ---
    await db.propertyAuditRun.update({
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
    console.error(`runPropertyAudit(${auditRunId}) failed:`, err);
    await db.propertyAuditRun.update({
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

async function fetchRecordBase(
  objectType: SupportedAuditObjectType
): Promise<number> {
  switch (objectType) {
    case "contacts":
      return getContactsTotal();
    case "companies":
      return getCompaniesTotal();
    case "deals":
      return getDealsTotal();
  }
}

/**
 * Build a workflow reference index. One GET per workflow (throttled).
 * Each workflow's full definition is stringified and lowercased so we can
 * substring-search property names in O(N) per property.
 *
 * Failure to fetch a single workflow's definition doesn't fail the audit;
 * we just drop that flow from the index (false-negative for references).
 */
async function buildWorkflowIndex(): Promise<WorkflowReferenceIndex> {
  const byFlow = new Map<string, string>();
  const flowNames = new Map<string, string>();

  // Collect all summaries first
  const summaries: Array<{ id: string; name: string }> = [];
  for await (const page of paginateWorkflows()) {
    for (const flow of page) {
      summaries.push({ id: flow.id, name: flow.name });
    }
  }

  // Fetch full definitions in parallel via limit
  await Promise.all(
    summaries.map((summary) =>
      limit(async () => {
        try {
          const def = await withRetry(() => getWorkflowDefinition(summary.id));
          const serialized = JSON.stringify(def).toLowerCase();
          byFlow.set(summary.id, serialized);
          flowNames.set(summary.id, summary.name);
        } catch (e) {
          console.error(
            `getWorkflowDefinition(${summary.id}) failed:`,
            e instanceof Error ? e.message : e
          );
        }
      })
    )
  );

  return { byFlow, flowNames };
}

/**
 * Substring-search the workflow index for references to a property name.
 * Case-insensitive. Returns the list of flow IDs that mention the property.
 *
 * This is deliberately permissive — false positives push a property to
 * "review" instead of "archive", which is the safe direction.
 */
function findWorkflowReferences(
  index: WorkflowReferenceIndex,
  propertyName: string
): { referencedFlowIds: string[] } {
  const needle = propertyName.toLowerCase();
  // Skip extremely short property names (<4 chars) since they'd false-positive
  // everywhere. Those properties score as "0 workflow refs" — review UI can
  // flag this limitation if desired.
  if (needle.length < 4) return { referencedFlowIds: [] };

  const refs: string[] = [];
  for (const [flowId, serialized] of index.byFlow) {
    if (serialized.includes(needle)) refs.push(flowId);
  }
  return { referencedFlowIds: refs };
}

// Workflow detail type is re-exported so callers don't need to import from hubspot.ts
export type { HubSpotWorkflowDetail };
