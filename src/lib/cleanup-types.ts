// Cleanup audit constants + types.
// Shared between the property auditor, list auditor, UI, and weekly cron.
//
// Prisma models use strings for status / recommendation to match the existing
// ScanRun pattern; these constants document the allowed values.

// ============================================================
// Audit run status
// ============================================================

export const AUDIT_RUN_STATUSES = ["queued", "running", "complete", "failed"] as const;
export type AuditRunStatus = (typeof AUDIT_RUN_STATUSES)[number];

export const PROPERTY_AUDIT_STAGES = [
  "loading_properties",
  "counting",
  "loading_workflows",
  "scoring",
  "persisting",
] as const;
export type PropertyAuditStage = (typeof PROPERTY_AUDIT_STAGES)[number];

export const LIST_AUDIT_STAGES = ["loading_lists", "scoring", "persisting"] as const;
export type ListAuditStage = (typeof LIST_AUDIT_STAGES)[number];

export const WORKFLOW_AUDIT_STAGES = [
  "loading_workflows",
  "loading_details",
  "scoring",
  "persisting",
] as const;
export type WorkflowAuditStage = (typeof WORKFLOW_AUDIT_STAGES)[number];

export const FORM_AUDIT_STAGES = [
  "loading_forms",
  "loading_submissions",
  "scoring",
  "persisting",
] as const;
export type FormAuditStage = (typeof FORM_AUDIT_STAGES)[number];

export const BULK_ACTION_STATUSES = ["running", "complete", "failed"] as const;
export type BulkActionStatus = (typeof BULK_ACTION_STATUSES)[number];

// ============================================================
// Finding status (per-item)
// ============================================================

/**
 * A finding's lifecycle:
 *   pending -> acknowledged | archived | deleted | failed | skipped | stale
 *
 * - acknowledged: user reviewed and chose to keep. Writes SuppressedProperty/List.
 * - archived/deleted: action succeeded against HubSpot.
 * - failed: HubSpot API returned an error; errorMessage populated.
 * - skipped: bulk action or UI-level "skip this one".
 * - stale: re-fetch showed state changed since audit (e.g. property now in a
 *   workflow, list now referenced). Action refused safely.
 */
export const PROPERTY_FINDING_STATUSES = [
  "pending",
  "acknowledged",
  "archived",
  "failed",
  "skipped",
  "stale",
] as const;
export type PropertyFindingStatus = (typeof PROPERTY_FINDING_STATUSES)[number];

export const LIST_FINDING_STATUSES = [
  "pending",
  "acknowledged",
  "deleted",
  "failed",
  "skipped",
  "stale",
] as const;
export type ListFindingStatus = (typeof LIST_FINDING_STATUSES)[number];

export const WORKFLOW_FINDING_STATUSES = [
  "pending",
  "acknowledged",
  "disabled",
  "failed",
  "skipped",
  "stale",
] as const;
export type WorkflowFindingStatus = (typeof WORKFLOW_FINDING_STATUSES)[number];

export const FORM_FINDING_STATUSES = [
  "pending",
  "acknowledged",
  "archived",
  "failed",
  "skipped",
  "stale",
] as const;
export type FormFindingStatus = (typeof FORM_FINDING_STATUSES)[number];

// ============================================================
// Recommendation (what the scorer suggests)
// ============================================================

export const PROPERTY_RECOMMENDATIONS = ["archive", "review", "keep"] as const;
export type PropertyRecommendation = (typeof PROPERTY_RECOMMENDATIONS)[number];

export const LIST_RECOMMENDATIONS = ["delete", "review", "keep"] as const;
export type ListRecommendation = (typeof LIST_RECOMMENDATIONS)[number];

export const WORKFLOW_RECOMMENDATIONS = ["disable", "review", "keep"] as const;
export type WorkflowRecommendation = (typeof WORKFLOW_RECOMMENDATIONS)[number];

export const FORM_RECOMMENDATIONS = ["archive", "review", "keep"] as const;
export type FormRecommendation = (typeof FORM_RECOMMENDATIONS)[number];

// ============================================================
// Object type union (repeated here to avoid a circular import with hubspot.ts)
// ============================================================

export const AUDIT_OBJECT_TYPES = ["contacts", "companies", "deals"] as const;
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

// ============================================================
// Scoring configuration (versioned — snapshotted into AuditRun.ruleSet JSON
// so historical findings can be explained even after weights change).
// ============================================================

export const PROPERTY_SCORING_VERSION = "v1-2026-04-24";
export const LIST_SCORING_VERSION = "v1-2026-04-24";

export const PROPERTY_RECOMMENDATION_THRESHOLDS = {
  archive: 0.9, // score >= 0.9  -> "archive"
  review: 0.6, // score >= 0.6  -> "review", otherwise "keep"
} as const;

export const LIST_RECOMMENDATION_THRESHOLDS = {
  delete: 0.85,
  review: 0.5,
} as const;

export const WORKFLOW_SCORING_VERSION = "v1-2026-04-24";
export const WORKFLOW_RECOMMENDATION_THRESHOLDS = {
  // Disable threshold higher than list delete (workflows have bigger side-effects
  // if wrong — but disable is reversible so still 0.85 is acceptable).
  disable: 0.85,
  review: 0.5,
} as const;

export const FORM_SCORING_VERSION = "v1-2026-04-24";
export const FORM_RECOMMENDATION_THRESHOLDS = {
  // Archive is reversible in HubSpot (soft delete) — similar to property archive.
  archive: 0.85,
  review: 0.5,
} as const;

// ============================================================
// Misc
// ============================================================

export const MONTHS_12_MS = 12 * 30 * 24 * 60 * 60 * 1000;
export const MONTHS_24_MS = 24 * 30 * 24 * 60 * 60 * 1000;
export const MONTHS_6_MS = 6 * 30 * 24 * 60 * 60 * 1000;

/** Used as a hard safety check in action handlers. */
export function isDryRun(): boolean {
  return process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
}
