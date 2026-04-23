// Slack notifier — posts DMs to a fixed user via the Slack bot token.
// Configured via env:
//   SLACK_BOT_TOKEN — xoxb-... token from the HubSpot Dedupe Slack app
//   SLACK_DM_USER_ID — Slack user ID to DM (e.g. <YOUR_SLACK_USER_ID>)
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
