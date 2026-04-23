# HubSpot Dedupe

A self-hosted tool that scans a HubSpot portal, finds duplicate contacts and companies using tiered matching rules, and merges them from a review dashboard — or on a weekly schedule via launchd + a Slack DM summary.

Built with Next.js 16 (App Router, React 19), Prisma 7 (SQLite via `better-sqlite3`), Tailwind 4, and Base UI / shadcn.

## Features

- **Full-portal scan** using HubSpot's basic "getPage" API (no 10k search cap)
- **Tiered matching:**
  - Tier 1.1 — same LinkedIn URL (highest confidence, overrides all else)
  - Tier 1.2 — same email (contact) / same domain (company)
  - Tier 2 — normalized name + company match
  - Tier 3 — fuzzy name within a block
- **Conflict-safety check** — two records with different non-empty emails or LinkedIn URLs are never collapsed, even if name + company match, to protect against broken-automation name collisions.
- **Canonical ID resolution** — HubSpot leaves forward references after merges; the scanner batch-resolves them before emitting groups.
- **Per-field merge strategies** — choose winners per property (e.g. `primary_if_not_empty`, `longest_non_empty`, `most_recent_lastmodified`, `valid_e164_first`). Primary gets PATCHed before the merge call so HubSpot's default "primary wins" behaviour doesn't clobber your choices.
- **Suppressed pairs** — "Skip" in the UI writes to a `SuppressedPair` table so they don't come back in the next scan.
- **Weekly scheduled run** — `scripts/weekly-dedupe.ts` scans, auto-merges any group with score ≥ 0.99, and DMs you a Slack summary. Installable as a launchd job on macOS.

## Prerequisites

- Node 20+ (Homebrew `/opt/homebrew/bin/node`)
- A HubSpot Private App token with contacts + companies read/write scopes
- (Optional, for scheduled runs) A Slack app with `chat:write`, `im:write`, `users:read`, `users:read.email` scopes

## Quick start

```bash
# 1. Install
npm install

# 2. Set up env
cp .env.local.example .env.local
# edit .env.local — set HUBSPOT_ACCESS_TOKEN at minimum

# 3. Initialise the local SQLite DB
npx prisma migrate deploy
npx prisma generate

# 4. Run the dashboard
npm run dev
# open http://localhost:3000
```

From the dashboard:
- Click **+ New Scan** to launch a scan
- Wait for pagination to finish (3–5 min for ~50k contacts)
- Review detected groups, click into one to see member records side-by-side
- Pick a merge strategy per field or accept defaults
- Hit **Merge** for one group, or **Auto-merge all** for everything ≥ 0.99

## Weekly scheduled runs (macOS)

See [`DEPLOY-WEEKLY.md`](./DEPLOY-WEEKLY.md) for the full guide. Short version:

```bash
# Add SLACK_BOT_TOKEN, SLACK_DM_USER_ID, DEDUPE_DASHBOARD_URL to .env.local
# Then:
bash scripts/launchd/install.sh
```

That installs a launchd job that runs `npm run weekly-dedupe` every Sunday at 2:00 AM and sends the summary as a Slack DM.

Manually trigger a run any time with:
```bash
npm run weekly-dedupe
```

## Project layout

```
prisma/schema.prisma        Data model (ScanRun, DuplicateGroup, GroupMember, SuppressedPair)
src/lib/hubspot.ts          HubSpot API wrapper (pagination, batch reads, canonical ID resolution)
src/lib/normalize.ts        Field normalization (email, phone E.164, LinkedIn URL, name, company)
src/lib/match.ts            Tiered detection + union-find + conflict check
src/lib/merge.ts            Per-field strategies + PATCH-then-merge pipeline
src/lib/scanner.ts          Scan orchestrator; filters suppressed pairs and forward-refs
src/lib/slack.ts            Block Kit formatter + chat.postMessage wrapper
src/app/page.tsx            Dashboard (live HubSpot totals, past scans, latest scheduled run)
src/app/scan/[id]/          Per-scan review UI + server actions for merge + skip
scripts/weekly-dedupe.ts    CLI entry point for the weekly cron
scripts/launchd/            launchd plist template + installer for macOS scheduling
```

## Merge rules

See [`MERGE_RULES.md`](./MERGE_RULES.md) for the full per-field strategy table, and [`PLAN.md`](./PLAN.md) for the original design doc / decision log.

## Licensing

None included — add one before publishing if that matters to you.
