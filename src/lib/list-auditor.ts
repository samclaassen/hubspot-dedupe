// List auditor — analog to property-auditor.ts for HubSpot lists/segments.
//
// Lifecycle:
//   1. init          — status=running, stage=loading_lists
//   2. loading_lists — paginateLists() (uses POST /crm/v3/lists/search)
//   3. scoring       — scoreList() with hs_list_reference_count + hs_last_record_*
//   4. persisting    — filter suppressed, batched create of ListFinding rows
//   5. complete
//
// No workflow iteration needed: HubSpot's list metadata already exposes
// `hs_list_reference_count` (workflows/reports using the list).

import { db } from "./db";
import { paginateLists, type HubSpotList } from "./hubspot";
import { scoreList, type ScoreListInput } from "./cleanup-scoring";

export async function runListAudit(auditRunId: string): Promise<void> {
  try {
    const run = await db.listAuditRun.findUnique({ where: { id: auditRunId } });
    if (!run) throw new Error(`ListAuditRun ${auditRunId} not found`);

    await db.listAuditRun.update({
      where: { id: auditRunId },
      data: { status: "running", stage: "loading_lists" },
    });

    // --- 1. Enumerate all lists ---
    const lists: HubSpotList[] = [];
    for await (const page of paginateLists()) {
      lists.push(...page);
      await db.listAuditRun.update({
        where: { id: auditRunId },
        data: { listsScanned: lists.length },
      });
    }

    await db.listAuditRun.update({
      where: { id: auditRunId },
      data: {
        stage: "scoring",
        totalLists: lists.length,
      },
    });

    // --- 2. Score each list ---
    const suppressed = await db.suppressedList.findMany();
    const suppressedIds = new Set(suppressed.map((s) => s.hubspotListId));

    type PreparedFinding = {
      hubspotListId: string;
      name: string;
      processingType: string;
      objectTypeId: string;
      createdAt: Date;
      updatedAt: Date;
      filtersUpdatedAt: Date | null;
      memberCount: number;
      referenceCount: number;
      lastRecordAddedAt: Date | null;
      lastRecordRemovedAt: Date | null;
      confidence: number;
      recommendation: string;
      status: string;
      reasonJson: string;
      metadataSnapshot: string;
    };

    const findings: PreparedFinding[] = [];
    for (const list of lists) {
      if (suppressedIds.has(list.listId)) continue;

      const extras = list.additionalProperties ?? {};
      const memberCount = parseIntOrZero(extras.hs_list_size);
      const referenceCount = parseIntOrZero(extras.hs_list_reference_count);
      const lastRecordAddedAt = parseEpochMs(extras.hs_last_record_added_at);
      const lastRecordRemovedAt = parseEpochMs(extras.hs_last_record_removed_at);

      const createdAt = new Date(list.createdAt);
      const updatedAt = new Date(list.updatedAt);
      const filtersUpdatedAt = list.filtersUpdatedAt
        ? new Date(list.filtersUpdatedAt)
        : null;

      const input: ScoreListInput = {
        name: list.name,
        processingType: list.processingType,
        createdAt,
        updatedAt,
        filtersUpdatedAt,
        memberCount,
        referenceCount,
        lastRecordAddedAt,
        lastRecordRemovedAt,
      };

      const result = scoreList(input);

      findings.push({
        hubspotListId: list.listId,
        name: list.name,
        processingType: list.processingType,
        objectTypeId: list.objectTypeId,
        createdAt,
        updatedAt,
        filtersUpdatedAt,
        memberCount,
        referenceCount,
        lastRecordAddedAt,
        lastRecordRemovedAt,
        confidence: result.confidence,
        recommendation: result.recommendation,
        status: "pending",
        reasonJson: JSON.stringify({
          factors: result.factors,
          notes: result.notes,
          version: result.version,
        }),
        metadataSnapshot: JSON.stringify(list),
      });
    }

    // --- 3. Persist findings (batched) ---
    await db.listAuditRun.update({
      where: { id: auditRunId },
      data: { stage: "persisting" },
    });

    const BATCH = 50;
    for (let i = 0; i < findings.length; i += BATCH) {
      const slice = findings.slice(i, i + BATCH);
      await db.$transaction(
        slice.map((f) =>
          db.listFinding.create({
            data: { auditRunId, ...f },
          })
        )
      );
    }

    // --- 4. Mark complete ---
    await db.listAuditRun.update({
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
    console.error(`runListAudit(${auditRunId}) failed:`, err);
    await db.listAuditRun.update({
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

function parseIntOrZero(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseEpochMs(raw: string | undefined): Date | null {
  if (!raw) return null;
  // HubSpot returns these as epoch milliseconds in string form.
  const ms = Number.parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}
