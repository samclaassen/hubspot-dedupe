// Slack notifier — posts DMs to a fixed user via the Slack bot token.
// Configured via env:
//   SLACK_BOT_TOKEN — xoxb-... token from the HubSpot Dedupe Slack app
//   SLACK_DM_USER_ID — Slack user ID to DM (e.g. U0XXXXXXXXX)
//
// Uses chat.postMessage with the user ID as the channel — Slack auto-opens
// the bot's DM channel with that user.

type SlackBlock = Record<string, unknown>;

export type SlackPostOptions = {
  text: string; // Fallback text (used in notifications + clients without block support)
  blocks?: SlackBlock[]; // Optional rich formatting
};

export async function postSlackDM(opts: SlackPostOptions): Promise<{
  ok: boolean;
  error?: string;
}> {
  const token = process.env.SLACK_BOT_TOKEN;
  const userId = process.env.SLACK_DM_USER_ID;
  if (!token || !userId) {
    return {
      ok: false,
      error: "SLACK_BOT_TOKEN or SLACK_DM_USER_ID not set — cannot post to Slack",
    };
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: userId,
        text: opts.text,
        ...(opts.blocks ? { blocks: opts.blocks } : {}),
      }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      return { ok: false, error: data.error ?? "Unknown Slack API error" };
    }
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Format a weekly dedupe summary message using Slack Block Kit.
 * Use this to get a clean DM with a header + KPIs + a link to review.
 */
export function buildWeeklyDedupeSummary(opts: {
  scanId: string;
  scanStartedAt: Date;
  recordsScanned: number;
  groupsFound: number;
  autoMerged: number;
  autoMergeFailed: number;
  pendingReview: number;
  skippedSuppressed: number;
  dashboardUrl: string;
  error?: string;
}): SlackPostOptions {
  const {
    scanStartedAt,
    recordsScanned,
    groupsFound,
    autoMerged,
    autoMergeFailed,
    pendingReview,
    skippedSuppressed,
    dashboardUrl,
    error,
  } = opts;

  if (error) {
    return {
      text: `❌ Weekly dedupe failed: ${error}`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "❌ Weekly dedupe FAILED", emoji: true },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Run started ${scanStartedAt.toLocaleString()}\n\n\`\`\`${error.slice(0, 600)}\`\`\``,
          },
        },
      ],
    };
  }

  const fallbackText =
    `Weekly dedupe complete. ${autoMerged} merged, ${pendingReview} need review` +
    (autoMergeFailed > 0 ? `, ${autoMergeFailed} failed.` : ".");

  const summaryFields: { type: string; text: string }[] = [
    { type: "mrkdwn", text: `*Records scanned*\n${recordsScanned.toLocaleString()}` },
    { type: "mrkdwn", text: `*Duplicate groups*\n${groupsFound.toLocaleString()}` },
    { type: "mrkdwn", text: `*Auto-merged*\n${autoMerged.toLocaleString()}` },
    { type: "mrkdwn", text: `*Needs review*\n${pendingReview.toLocaleString()}` },
  ];
  if (autoMergeFailed > 0) {
    summaryFields.push({
      type: "mrkdwn",
      text: `*Failed*\n${autoMergeFailed.toLocaleString()}`,
    });
  }
  if (skippedSuppressed > 0) {
    summaryFields.push({
      type: "mrkdwn",
      text: `*Suppressed*\n${skippedSuppressed.toLocaleString()}`,
    });
  }

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🧹 Weekly HubSpot dedupe", emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Run started ${scanStartedAt.toLocaleString()}` },
      ],
    },
    { type: "section", fields: summaryFields },
  ];

  if (pendingReview > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${pendingReview} groups need a human look. <${dashboardUrl}|Open the review dashboard>`,
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No review needed. Everything auto-merged cleanly.",
      },
    });
  }

  return { text: fallbackText, blocks };
}

// ============================================================
// Unified weekly cleanup summary (dedupe + property audit + list audit).
// Used by scripts/weekly-cleanup.ts in Stage 4+.
// ============================================================

export type CleanupSectionStatus = "ok" | "failed" | "skipped";

export type DedupeSection = {
  status: CleanupSectionStatus;
  scanId?: string;
  recordsScanned?: number;
  groupsFound?: number;
  autoMerged?: number;
  autoMergeFailed?: number;
  pendingReview?: number;
  dashboardUrl?: string;
  error?: string;
};

export type PropertyAuditSection = {
  status: CleanupSectionStatus;
  auditId?: string;
  totalProperties?: number;
  archiveReady?: number;
  review?: number;
  keep?: number;
  dashboardUrl?: string;
  error?: string;
};

export type ListAuditSection = {
  status: CleanupSectionStatus;
  auditId?: string;
  totalLists?: number;
  deleteReady?: number;
  review?: number;
  keep?: number;
  dashboardUrl?: string;
  error?: string;
};

export type WorkflowAuditSection = {
  status: CleanupSectionStatus;
  auditId?: string;
  totalWorkflows?: number;
  disableReady?: number;
  review?: number;
  keep?: number;
  dashboardUrl?: string;
  error?: string;
};

export type FormAuditSection = {
  status: CleanupSectionStatus;
  auditId?: string;
  totalForms?: number;
  archiveReady?: number;
  review?: number;
  keep?: number;
  dashboardUrl?: string;
  error?: string;
};

export function buildWeeklyCleanupSummary(opts: {
  runStartedAt: Date;
  dedupe: DedupeSection;
  properties: PropertyAuditSection;
  lists: ListAuditSection;
  workflows: WorkflowAuditSection;
  forms: FormAuditSection;
}): SlackPostOptions {
  const { runStartedAt, dedupe, properties, lists, workflows, forms } = opts;

  const fallbackText =
    `Weekly cleanup complete: ` +
    `${dedupe.status === "ok" ? `${dedupe.autoMerged ?? 0} merged` : "dedupe failed"}, ` +
    `${properties.status === "ok" ? `${properties.archiveReady ?? 0} properties archive-ready` : "props failed"}, ` +
    `${lists.status === "ok" ? `${lists.deleteReady ?? 0} lists delete-ready` : "lists failed"}, ` +
    `${workflows.status === "ok" ? `${workflows.disableReady ?? 0} workflows disable-ready` : "workflows failed"}, ` +
    `${forms.status === "ok" ? `${forms.archiveReady ?? 0} forms archive-ready` : "forms failed"}.`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🧹 Weekly HubSpot cleanup", emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Run started ${runStartedAt.toLocaleString()}` },
      ],
    },
  ];

  // --- Dedupe section ---
  blocks.push({ type: "divider" });
  if (dedupe.status === "failed") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Dedupe*: ❌ failed\n\`\`\`${(dedupe.error ?? "unknown").slice(0, 400)}\`\`\``,
      },
    });
  } else if (dedupe.status === "skipped") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Dedupe*: skipped" },
    });
  } else {
    const fields: { type: string; text: string }[] = [
      {
        type: "mrkdwn",
        text: `*Records scanned*\n${(dedupe.recordsScanned ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Duplicate groups*\n${(dedupe.groupsFound ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Auto-merged*\n${(dedupe.autoMerged ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Needs review*\n${(dedupe.pendingReview ?? 0).toLocaleString()}`,
      },
    ];
    if ((dedupe.autoMergeFailed ?? 0) > 0) {
      fields.push({
        type: "mrkdwn",
        text: `*Failed*\n${dedupe.autoMergeFailed!.toLocaleString()}`,
      });
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Dedupe*" } });
    blocks.push({ type: "section", fields });
    if (dedupe.pendingReview && dedupe.dashboardUrl) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${dedupe.dashboardUrl}|Open dedupe review →>`,
        },
      });
    }
  }

  // --- Property audit section ---
  blocks.push({ type: "divider" });
  if (properties.status === "failed") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Properties*: ❌ failed\n\`\`\`${(properties.error ?? "unknown").slice(0, 400)}\`\`\``,
      },
    });
  } else if (properties.status === "skipped") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Properties*: skipped" },
    });
  } else {
    const fields: { type: string; text: string }[] = [
      {
        type: "mrkdwn",
        text: `*Scanned*\n${(properties.totalProperties ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Archive-ready*\n${(properties.archiveReady ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Review*\n${(properties.review ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Keep*\n${(properties.keep ?? 0).toLocaleString()}`,
      },
    ];
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Properties*" } });
    blocks.push({ type: "section", fields });
    if (properties.archiveReady && properties.dashboardUrl) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${properties.dashboardUrl}|Review property findings →>`,
        },
      });
    }
  }

  // --- List audit section ---
  blocks.push({ type: "divider" });
  if (lists.status === "failed") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Lists*: ❌ failed\n\`\`\`${(lists.error ?? "unknown").slice(0, 400)}\`\`\``,
      },
    });
  } else if (lists.status === "skipped") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Lists*: skipped" },
    });
  } else {
    const fields: { type: string; text: string }[] = [
      {
        type: "mrkdwn",
        text: `*Scanned*\n${(lists.totalLists ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Delete-ready*\n${(lists.deleteReady ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Review*\n${(lists.review ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Keep*\n${(lists.keep ?? 0).toLocaleString()}`,
      },
    ];
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Lists*" } });
    blocks.push({ type: "section", fields });
    if (lists.deleteReady && lists.dashboardUrl) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${lists.dashboardUrl}|Review list findings →>`,
        },
      });
    }
  }

  // --- Workflow audit section ---
  blocks.push({ type: "divider" });
  if (workflows.status === "failed") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Workflows*: ❌ failed\n\`\`\`${(workflows.error ?? "unknown").slice(0, 400)}\`\`\``,
      },
    });
  } else if (workflows.status === "skipped") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Workflows*: skipped" },
    });
  } else {
    const fields: { type: string; text: string }[] = [
      {
        type: "mrkdwn",
        text: `*Scanned*\n${(workflows.totalWorkflows ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Disable-ready*\n${(workflows.disableReady ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Review*\n${(workflows.review ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Keep*\n${(workflows.keep ?? 0).toLocaleString()}`,
      },
    ];
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Workflows*" } });
    blocks.push({ type: "section", fields });
    if (workflows.disableReady && workflows.dashboardUrl) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${workflows.dashboardUrl}|Review workflow findings →>`,
        },
      });
    }
  }

  // --- Form audit section ---
  blocks.push({ type: "divider" });
  if (forms.status === "failed") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Forms*: ❌ failed\n\`\`\`${(forms.error ?? "unknown").slice(0, 400)}\`\`\``,
      },
    });
  } else if (forms.status === "skipped") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Forms*: skipped" },
    });
  } else {
    const fields: { type: string; text: string }[] = [
      {
        type: "mrkdwn",
        text: `*Scanned*\n${(forms.totalForms ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Archive-ready*\n${(forms.archiveReady ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Review*\n${(forms.review ?? 0).toLocaleString()}`,
      },
      {
        type: "mrkdwn",
        text: `*Keep*\n${(forms.keep ?? 0).toLocaleString()}`,
      },
    ];
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Forms*" } });
    blocks.push({ type: "section", fields });
    if (forms.archiveReady && forms.dashboardUrl) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${forms.dashboardUrl}|Review form findings →>`,
        },
      });
    }
  }

  return { text: fallbackText, blocks };
}
