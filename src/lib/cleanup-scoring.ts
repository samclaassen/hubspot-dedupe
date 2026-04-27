// Pure scoring functions for the cleanup audit.
// No DB, no HubSpot — just math. Makes these easy to unit-test.
//
// Version is snapshotted into AuditRun.ruleSet JSON so historical findings
// can be explained after weights change.

import {
  PROPERTY_RECOMMENDATION_THRESHOLDS,
  PROPERTY_SCORING_VERSION,
  LIST_RECOMMENDATION_THRESHOLDS,
  LIST_SCORING_VERSION,
  WORKFLOW_RECOMMENDATION_THRESHOLDS,
  WORKFLOW_SCORING_VERSION,
  FORM_RECOMMENDATION_THRESHOLDS,
  FORM_SCORING_VERSION,
  MONTHS_12_MS,
  MONTHS_24_MS,
  MONTHS_6_MS,
  type PropertyRecommendation,
  type ListRecommendation,
  type WorkflowRecommendation,
  type FormRecommendation,
} from "./cleanup-types";

const MONTHS_3_MS = (MONTHS_6_MS ?? 0) / 2;
const DAYS_30_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// Property scoring
// ============================================================

export type ScorePropertyInput = {
  // From the property metadata
  hubspotDefined: boolean;
  archivable: boolean;
  hidden: boolean;
  formField: boolean;
  hasFormula: boolean;
  lastModifiedAt: Date | null;
  // From record scan
  populatedCount: number;
  recordBase: number;
  // From workflow scan
  referencedInWorkflows: number;
};

export type ScoreFactor = {
  factor: string;
  weight: number;
  triggered: boolean;
};

export type ScorePropertyResult = {
  confidence: number; // 0.0 – 1.0
  recommendation: PropertyRecommendation;
  factors: ScoreFactor[]; // all factors we evaluated (for UI transparency)
  notes: string[]; // hard-cap reasons
  version: string;
};

export function scoreProperty(input: ScorePropertyInput): ScorePropertyResult {
  const factors: ScoreFactor[] = [];
  const notes: string[] = [];
  const now = Date.now();

  const ratio =
    input.recordBase > 0 ? input.populatedCount / input.recordBase : 0;

  // --- Additive factors ---

  const f_zeroPopulated: ScoreFactor = {
    factor: "populatedCount === 0",
    weight: 0.55,
    triggered: input.populatedCount === 0,
  };
  factors.push(f_zeroPopulated);

  const f_under0_1pct: ScoreFactor = {
    factor: "populated <0.1% of records",
    weight: 0.35,
    triggered: input.populatedCount > 0 && ratio < 0.001,
  };
  factors.push(f_under0_1pct);

  const f_under1pct: ScoreFactor = {
    factor: "populated <1% of records",
    weight: 0.2,
    triggered:
      input.populatedCount > 0 && ratio >= 0.001 && ratio < 0.01,
  };
  factors.push(f_under1pct);

  const f_notHubspotDefined: ScoreFactor = {
    factor: "not HubSpot-defined (custom property)",
    weight: 0.15,
    triggered: !input.hubspotDefined,
  };
  factors.push(f_notHubspotDefined);

  const f_archivable: ScoreFactor = {
    factor: "archivable flag set",
    weight: 0.1,
    triggered: input.archivable,
  };
  factors.push(f_archivable);

  const f_noFormula: ScoreFactor = {
    factor: "not a calculated property",
    weight: 0.1,
    triggered: !input.hasFormula,
  };
  factors.push(f_noFormula);

  const f_noWorkflowRef: ScoreFactor = {
    factor: "no workflow references",
    weight: 0.15,
    triggered: input.referencedInWorkflows === 0,
  };
  factors.push(f_noWorkflowRef);

  const f_notUserFacing: ScoreFactor = {
    factor: "not hidden + not a form field",
    weight: 0.05,
    triggered: !input.hidden && !input.formField,
  };
  factors.push(f_notUserFacing);

  const f_dormant: ScoreFactor = {
    factor: "definition not modified in >12 months",
    weight: 0.05,
    triggered:
      input.lastModifiedAt !== null &&
      now - input.lastModifiedAt.getTime() > MONTHS_12_MS,
  };
  factors.push(f_dormant);

  let score = factors
    .filter((f) => f.triggered)
    .reduce((sum, f) => sum + f.weight, 0);

  // Clamp additive to 1.0
  if (score > 1) score = 1;

  // --- Hard caps ---

  if (input.hubspotDefined) {
    score = 0;
    notes.push("HubSpot-defined property — never archive");
  }
  if (!input.archivable) {
    score = Math.min(score, 0.4);
    notes.push("property is locked (archivable=false)");
  }
  if (input.hasFormula) {
    score = Math.min(score, 0.5);
    notes.push("calculated property — deletion breaks the formula");
  }

  // --- Recommendation ---
  let recommendation: PropertyRecommendation;
  if (score >= PROPERTY_RECOMMENDATION_THRESHOLDS.archive) {
    recommendation = "archive";
  } else if (score >= PROPERTY_RECOMMENDATION_THRESHOLDS.review) {
    recommendation = "review";
  } else {
    recommendation = "keep";
  }
  // hubspotDefined hard-cap always "keep"
  if (input.hubspotDefined) recommendation = "keep";

  return {
    confidence: Number(score.toFixed(3)),
    recommendation,
    factors,
    notes,
    version: PROPERTY_SCORING_VERSION,
  };
}

// ============================================================
// List scoring
// ============================================================

export type ScoreListInput = {
  name: string;
  processingType: "MANUAL" | "DYNAMIC" | "SNAPSHOT";
  createdAt: Date;
  updatedAt: Date;
  filtersUpdatedAt: Date | null;
  memberCount: number;
  referenceCount: number; // hs_list_reference_count from HubSpot
  lastRecordAddedAt: Date | null;
  lastRecordRemovedAt: Date | null;
};

export type ScoreListResult = {
  confidence: number;
  recommendation: ListRecommendation;
  factors: ScoreFactor[];
  notes: string[];
  version: string;
};

const DISPOSABLE_NAME_RE =
  /^\s*(test|temp|untitled|copy of|list \d+|new list|draft)\b/i;

export function scoreList(input: ScoreListInput): ScoreListResult {
  const factors: ScoreFactor[] = [];
  const notes: string[] = [];
  const now = Date.now();

  const lastActivity = Math.max(
    input.updatedAt.getTime(),
    input.filtersUpdatedAt?.getTime() ?? 0,
    input.lastRecordAddedAt?.getTime() ?? 0,
    input.lastRecordRemovedAt?.getTime() ?? 0
  );
  const inactiveMs = now - lastActivity;

  const f_empty: ScoreFactor = {
    factor: "memberCount === 0",
    weight: 0.35,
    triggered: input.memberCount === 0,
  };
  factors.push(f_empty);

  const f_tiny: ScoreFactor = {
    factor: "memberCount < 10 (and >0)",
    weight: 0.1,
    triggered: input.memberCount > 0 && input.memberCount < 10,
  };
  factors.push(f_tiny);

  const f_dormant12: ScoreFactor = {
    factor: "no activity in >12 months",
    weight: 0.3,
    triggered: inactiveMs > MONTHS_12_MS,
  };
  factors.push(f_dormant12);

  const f_dormant24: ScoreFactor = {
    factor: "no activity in >24 months",
    weight: 0.15,
    triggered: inactiveMs > MONTHS_24_MS,
  };
  factors.push(f_dormant24);

  const f_noReferences: ScoreFactor = {
    factor: "no references (workflows / reports)",
    weight: 0.3,
    triggered: input.referenceCount === 0,
  };
  factors.push(f_noReferences);

  const f_snapshot: ScoreFactor = {
    factor: "SNAPSHOT type (frozen list)",
    weight: 0.1,
    triggered: input.processingType === "SNAPSHOT",
  };
  factors.push(f_snapshot);

  const f_disposableName: ScoreFactor = {
    factor: "name matches disposable pattern",
    weight: 0.1,
    triggered: DISPOSABLE_NAME_RE.test(input.name),
  };
  factors.push(f_disposableName);

  let score = factors
    .filter((f) => f.triggered)
    .reduce((sum, f) => sum + f.weight, 0);

  if (score > 1) score = 1;

  // --- Hard caps ---

  if (input.referenceCount > 0) {
    score = Math.min(score, 0.5);
    notes.push(
      `list is referenced ${input.referenceCount} time(s) — delete would break workflows/reports`
    );
  }

  if (input.memberCount > 1000 && inactiveMs < MONTHS_6_MS) {
    score = 0;
    notes.push("large + recently active list — keep");
  }

  // --- Recommendation ---
  let recommendation: ListRecommendation;
  if (score >= LIST_RECOMMENDATION_THRESHOLDS.delete) {
    recommendation = "delete";
  } else if (score >= LIST_RECOMMENDATION_THRESHOLDS.review) {
    recommendation = "review";
  } else {
    recommendation = "keep";
  }

  return {
    confidence: Number(score.toFixed(3)),
    recommendation,
    factors,
    notes,
    version: LIST_SCORING_VERSION,
  };
}

// ============================================================
// Workflow scoring
//
// HubSpot exposes: isEnabled, updatedAt, createdAt, revisionId, actions[].
// It does NOT expose per-workflow enrollment counts or last-fired timestamps.
// So "dormancy" is inferred from updatedAt + revisionId only, and the strongest
// signal is `!isEnabled` (the user has already turned it off, we just suggest
// cleanup).
//
// Recommendation in v1 is "disable" (reversible PUT), not "delete" (hard,
// requires HubSpot Support to recover).
// ============================================================

export type ScoreWorkflowInput = {
  name: string;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  revisionId: string;
  actionCount: number;
};

export type ScoreWorkflowResult = {
  confidence: number;
  recommendation: WorkflowRecommendation;
  factors: ScoreFactor[];
  notes: string[];
  version: string;
};

const WORKFLOW_DISPOSABLE_NAME_RE =
  /^\s*(test|temp|untitled|copy of|draft|wip|new workflow)\b/i;

export function scoreWorkflow(input: ScoreWorkflowInput): ScoreWorkflowResult {
  const factors: ScoreFactor[] = [];
  const notes: string[] = [];
  const now = Date.now();
  const inactiveMs = now - input.updatedAt.getTime();

  const f_disabled: ScoreFactor = {
    factor: "!isEnabled (already turned off)",
    weight: 0.55,
    triggered: !input.isEnabled,
  };
  factors.push(f_disabled);

  const f_dormant12: ScoreFactor = {
    factor: "not modified in >12 months",
    weight: 0.25,
    triggered: inactiveMs > MONTHS_12_MS,
  };
  factors.push(f_dormant12);

  const f_dormant24: ScoreFactor = {
    factor: "not modified in >24 months",
    weight: 0.15,
    triggered: inactiveMs > MONTHS_24_MS,
  };
  factors.push(f_dormant24);

  const f_noActions: ScoreFactor = {
    factor: "0 actions (workflow does nothing)",
    weight: 0.2,
    triggered: input.actionCount === 0,
  };
  factors.push(f_noActions);

  const f_neverRevised: ScoreFactor = {
    factor: "revisionId === 1 (never refined)",
    weight: 0.1,
    triggered: input.revisionId === "1",
  };
  factors.push(f_neverRevised);

  const f_disposableName: ScoreFactor = {
    factor: "name matches disposable pattern",
    weight: 0.1,
    triggered: WORKFLOW_DISPOSABLE_NAME_RE.test(input.name),
  };
  factors.push(f_disposableName);

  let score = factors
    .filter((f) => f.triggered)
    .reduce((sum, f) => sum + f.weight, 0);
  if (score > 1) score = 1;

  // --- Hard caps ---

  // Enabled workflows get max 0.6 (review). We never recommend disabling a
  // currently-enabled workflow, because it's active automation and the blast
  // radius of wrongly disabling it is high. Sam can manually flip isEnabled
  // in HubSpot UI; next audit will then score it above threshold.
  if (input.isEnabled) {
    score = Math.min(score, 0.6);
    notes.push("workflow is enabled — capped at review (never auto-disable active workflows)");
  }

  // Recently updated (<3mo) enabled workflows are definitely active — floor to 0.
  if (input.isEnabled && inactiveMs < MONTHS_6_MS / 2) {
    score = 0;
    notes.push("workflow was updated recently — keep");
  }

  // --- Recommendation ---

  let recommendation: WorkflowRecommendation;
  if (score >= WORKFLOW_RECOMMENDATION_THRESHOLDS.disable) {
    recommendation = "disable";
  } else if (score >= WORKFLOW_RECOMMENDATION_THRESHOLDS.review) {
    recommendation = "review";
  } else {
    recommendation = "keep";
  }

  return {
    confidence: Number(score.toFixed(3)),
    recommendation,
    factors,
    notes,
    version: WORKFLOW_SCORING_VERSION,
  };
}

// ============================================================
// Form scoring
//
// Unlike workflows, HubSpot exposes real submission data per form, so
// "last submitted" is the strongest signal available.
// ============================================================

export type ScoreFormInput = {
  name: string;
  formType: string;
  createdAt: Date;
  updatedAt: Date;
  lastSubmittedAt: Date | null;
  submissionsSeen: boolean; // true if lastSubmittedAt !== null
  fieldCount: number;
};

export type ScoreFormResult = {
  confidence: number;
  recommendation: FormRecommendation;
  factors: ScoreFactor[];
  notes: string[];
  version: string;
};

const FORM_DISPOSABLE_NAME_RE =
  /^\s*(test|temp|untitled|copy of|draft|wip|new form|form \d+)\b/i;

export function scoreForm(input: ScoreFormInput): ScoreFormResult {
  const factors: ScoreFactor[] = [];
  const notes: string[] = [];
  const now = Date.now();
  const lastSub = input.lastSubmittedAt?.getTime();
  const subInactiveMs = lastSub ? now - lastSub : Infinity;
  const defInactiveMs = now - input.updatedAt.getTime();
  const ageMs = now - input.createdAt.getTime();

  const f_neverSubmitted: ScoreFactor = {
    factor: "never submitted (no submissions ever)",
    weight: 0.45,
    triggered: !input.submissionsSeen,
  };
  factors.push(f_neverSubmitted);

  const f_sub12: ScoreFactor = {
    factor: "last submission > 12 months ago",
    weight: 0.25,
    triggered: input.submissionsSeen && subInactiveMs > MONTHS_12_MS,
  };
  factors.push(f_sub12);

  const f_sub24: ScoreFactor = {
    factor: "last submission > 24 months ago",
    weight: 0.15,
    triggered: input.submissionsSeen && subInactiveMs > MONTHS_24_MS,
  };
  factors.push(f_sub24);

  const f_defDormant: ScoreFactor = {
    factor: "definition not modified in >12 months",
    weight: 0.1,
    triggered: defInactiveMs > MONTHS_12_MS,
  };
  factors.push(f_defDormant);

  const f_veryOld: ScoreFactor = {
    factor: "form > 24 months old",
    weight: 0.05,
    triggered: ageMs > MONTHS_24_MS,
  };
  factors.push(f_veryOld);

  const f_disposableName: ScoreFactor = {
    factor: "name matches disposable pattern",
    weight: 0.1,
    triggered: FORM_DISPOSABLE_NAME_RE.test(input.name),
  };
  factors.push(f_disposableName);

  const f_trivial: ScoreFactor = {
    factor: "≤1 field (empty / trivial form)",
    weight: 0.1,
    triggered: input.fieldCount <= 1,
  };
  factors.push(f_trivial);

  let score = factors
    .filter((f) => f.triggered)
    .reduce((sum, f) => sum + f.weight, 0);
  if (score > 1) score = 1;

  // --- Hard caps ---
  // Recently submitted → this form is in active use; keep.
  if (input.submissionsSeen && subInactiveMs < MONTHS_3_MS) {
    score = 0;
    notes.push("submitted recently — actively used");
  }
  // Brand-new form (≤30 days) — give it a chance, cap at review.
  if (ageMs < DAYS_30_MS) {
    score = Math.min(score, 0.5);
    notes.push("form is new (<30 days old) — capped at review");
  }

  // --- Recommendation ---
  let recommendation: FormRecommendation;
  if (score >= FORM_RECOMMENDATION_THRESHOLDS.archive) {
    recommendation = "archive";
  } else if (score >= FORM_RECOMMENDATION_THRESHOLDS.review) {
    recommendation = "review";
  } else {
    recommendation = "keep";
  }

  return {
    confidence: Number(score.toFixed(3)),
    recommendation,
    factors,
    notes,
    version: FORM_SCORING_VERSION,
  };
}
