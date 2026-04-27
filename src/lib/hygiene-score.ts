// Portal Hygiene Score — the "credit score for your HubSpot."
// Pure function: takes audit summary inputs, returns 0-100 overall + per-category.
//
// Scoring philosophy:
//   - "keep" recommendation = full credit (clean data)
//   - "review" recommendation = half credit (needs attention)
//   - "archive" / "delete" / "disable" recommendation = zero credit (cruft)
//
//   category_score = 100 * (keep + 0.5*review) / total
//
// For dedupe, the signal is duplicate-ratio instead: what % of records are
// caught up in duplicate groups. 0% = 100 score; scales down from there.
//
// Overall score = simple average of the 4 categories that have audit data.
// Categories without audit data are omitted (not counted as 0).

export type CategoryScore =
  | {
      label: string;
      measured: true;
      score: number; // 0–100
      summary: string; // "2,634 merged this quarter" etc.
      detail: string; // "0 groups found in last scan" etc.
      auditUrl: string | null;
    }
  | {
      label: string;
      measured: false;
      summary: string; // "No audit yet"
      detail: string; // "Run an audit to see the score"
      auditUrl: string | null;
    };

export type HygieneScoreResult = {
  overall: number | null; // null if no categories have data
  trend: "up" | "down" | "flat" | null; // future: compare vs prior run
  categories: [
    CategoryScore,
    CategoryScore,
    CategoryScore,
    CategoryScore,
    CategoryScore,
  ];
  measuredCount: number; // how many of the 5 have data
};

// ============================================================
// Dedupe
// ============================================================
export function scoreDedupe(input: {
  groupsFound: number | null;
  recordsScanned: number | null;
  scanId?: string;
  autoMerged?: number;
} | null): CategoryScore {
  if (
    !input ||
    input.groupsFound === null ||
    input.recordsScanned === null ||
    input.recordsScanned === 0
  ) {
    return {
      label: "Duplicate records",
      measured: false,
      summary: "No dedupe scan yet",
      detail: "Run a scan to see the score",
      auditUrl: "/scan/new",
    };
  }

  // ~2 records per group on average
  const dupeRecords = input.groupsFound * 2;
  const dupeRatio = dupeRecords / input.recordsScanned;
  // 0% dupes = 100; 5% = 75; 10% = 50; 20% = 0
  const score = Math.max(0, Math.min(100, Math.round(100 - dupeRatio * 500)));

  let detail = `${input.groupsFound.toLocaleString()} duplicate group${input.groupsFound === 1 ? "" : "s"} in last scan`;
  if (input.autoMerged && input.autoMerged > 0) {
    detail += ` · ${input.autoMerged.toLocaleString()} auto-merged`;
  }

  return {
    label: "Duplicate records",
    measured: true,
    score,
    summary: `${input.recordsScanned.toLocaleString()} records scanned`,
    detail,
    auditUrl: input.scanId ? `/scan/${input.scanId}` : null,
  };
}

// ============================================================
// Properties
// ============================================================
export function scoreProperties(input: {
  auditId: string;
  totalProperties: number;
  archiveReady: number;
  review: number;
  keep: number;
} | null): CategoryScore {
  if (!input || input.totalProperties === 0) {
    return {
      label: "Property cruft",
      measured: false,
      summary: "No property audit yet",
      detail: "Run an audit to see the score",
      auditUrl: "/cleanup/properties/new",
    };
  }
  const total = input.archiveReady + input.review + input.keep;
  if (total === 0) {
    return {
      label: "Property cruft",
      measured: false,
      summary: "No findings to score",
      detail: "Audit had zero pending findings",
      auditUrl: `/cleanup/properties/${input.auditId}`,
    };
  }
  const score = Math.round((100 * (input.keep + 0.5 * input.review)) / total);

  return {
    label: "Property cruft",
    measured: true,
    score,
    summary: `${input.totalProperties.toLocaleString()} properties scanned`,
    detail:
      `${input.archiveReady.toLocaleString()} archive-ready` +
      (input.review > 0 ? ` · ${input.review.toLocaleString()} review` : ""),
    auditUrl: `/cleanup/properties/${input.auditId}?filter=archive-ready`,
  };
}

// ============================================================
// Lists
// ============================================================
export function scoreLists(input: {
  auditId: string;
  totalLists: number;
  deleteReady: number;
  review: number;
  keep: number;
} | null): CategoryScore {
  if (!input || input.totalLists === 0) {
    return {
      label: "List hygiene",
      measured: false,
      summary: "No list audit yet",
      detail: "Run an audit to see the score",
      auditUrl: "/cleanup/lists/new",
    };
  }
  const total = input.deleteReady + input.review + input.keep;
  if (total === 0) {
    return {
      label: "List hygiene",
      measured: false,
      summary: "No findings to score",
      detail: "Audit had zero pending findings",
      auditUrl: `/cleanup/lists/${input.auditId}`,
    };
  }
  const score = Math.round((100 * (input.keep + 0.5 * input.review)) / total);

  return {
    label: "List hygiene",
    measured: true,
    score,
    summary: `${input.totalLists.toLocaleString()} lists scanned`,
    detail:
      `${input.deleteReady.toLocaleString()} delete-ready` +
      (input.review > 0 ? ` · ${input.review.toLocaleString()} review` : ""),
    auditUrl: `/cleanup/lists/${input.auditId}?filter=delete-ready`,
  };
}

// ============================================================
// Workflows
// ============================================================
export function scoreWorkflows(input: {
  auditId: string;
  totalWorkflows: number;
  disableReady: number;
  review: number;
  keep: number;
} | null): CategoryScore {
  if (!input || input.totalWorkflows === 0) {
    return {
      label: "Workflow sprawl",
      measured: false,
      summary: "No workflow audit yet",
      detail: "Run an audit to see the score",
      auditUrl: "/cleanup/workflows/new",
    };
  }
  const total = input.disableReady + input.review + input.keep;
  if (total === 0) {
    return {
      label: "Workflow sprawl",
      measured: false,
      summary: "No findings to score",
      detail: "Audit had zero pending findings",
      auditUrl: `/cleanup/workflows/${input.auditId}`,
    };
  }
  const score = Math.round((100 * (input.keep + 0.5 * input.review)) / total);

  return {
    label: "Workflow sprawl",
    measured: true,
    score,
    summary: `${input.totalWorkflows.toLocaleString()} workflows scanned`,
    detail:
      `${input.disableReady.toLocaleString()} disable-ready` +
      (input.review > 0 ? ` · ${input.review.toLocaleString()} review` : ""),
    auditUrl: `/cleanup/workflows/${input.auditId}?filter=disable-ready`,
  };
}

// ============================================================
// Forms
// ============================================================
export function scoreForms(input: {
  auditId: string;
  totalForms: number;
  archiveReady: number;
  review: number;
  keep: number;
} | null): CategoryScore {
  if (!input || input.totalForms === 0) {
    return {
      label: "Form clutter",
      measured: false,
      summary: "No form audit yet",
      detail: "Run an audit to see the score",
      auditUrl: "/cleanup/forms/new",
    };
  }
  const total = input.archiveReady + input.review + input.keep;
  if (total === 0) {
    return {
      label: "Form clutter",
      measured: false,
      summary: "No findings to score",
      detail: "Audit had zero pending findings",
      auditUrl: `/cleanup/forms/${input.auditId}`,
    };
  }
  const score = Math.round((100 * (input.keep + 0.5 * input.review)) / total);

  return {
    label: "Form clutter",
    measured: true,
    score,
    summary: `${input.totalForms.toLocaleString()} forms scanned`,
    detail:
      `${input.archiveReady.toLocaleString()} archive-ready` +
      (input.review > 0 ? ` · ${input.review.toLocaleString()} review` : ""),
    auditUrl: `/cleanup/forms/${input.auditId}?filter=archive-ready`,
  };
}

// ============================================================
// Overall
// ============================================================
export function computeHygieneScore(inputs: {
  dedupe: Parameters<typeof scoreDedupe>[0];
  properties: Parameters<typeof scoreProperties>[0];
  lists: Parameters<typeof scoreLists>[0];
  workflows: Parameters<typeof scoreWorkflows>[0];
  forms: Parameters<typeof scoreForms>[0];
}): HygieneScoreResult {
  const categories: [
    CategoryScore,
    CategoryScore,
    CategoryScore,
    CategoryScore,
    CategoryScore,
  ] = [
    scoreDedupe(inputs.dedupe),
    scoreProperties(inputs.properties),
    scoreLists(inputs.lists),
    scoreWorkflows(inputs.workflows),
    scoreForms(inputs.forms),
  ];

  const measured = categories.filter(
    (c): c is Extract<CategoryScore, { measured: true }> => c.measured
  );
  if (measured.length === 0) {
    return {
      overall: null,
      trend: null,
      categories,
      measuredCount: 0,
    };
  }
  const overall = Math.round(
    measured.reduce((sum, c) => sum + c.score, 0) / measured.length
  );

  return {
    overall,
    trend: null, // wire historical comparison in a future iteration
    categories,
    measuredCount: measured.length,
  };
}

// ============================================================
// Display helpers
// ============================================================

export function scoreColor(score: number): string {
  if (score >= 85) return "text-emerald-600";
  if (score >= 65) return "text-amber-500";
  if (score >= 40) return "text-orange-500";
  return "text-red-600";
}

export function scoreBarColor(score: number): string {
  if (score >= 85) return "bg-emerald-500";
  if (score >= 65) return "bg-amber-500";
  if (score >= 40) return "bg-orange-500";
  return "bg-red-500";
}

export function scoreLabel(score: number): string {
  if (score >= 90) return "Pristine";
  if (score >= 80) return "Healthy";
  if (score >= 65) return "Decent";
  if (score >= 40) return "Needs attention";
  if (score >= 20) return "Messy";
  return "Cluttered";
}
