# HubSpot Cleanup

Self-hosted Next.js app that audits a HubSpot portal for three categories of cruft and helps clean it up:

1. **Duplicate contacts + companies** → tiered detection rules, per-field merge strategies, bulk auto-merge.
2. **Unused / stale properties** → scored on populated-record count, workflow references, formula/archivable flags, etc. Archive is a HubSpot soft-delete (90-day recovery).
3. **Stale lists / segments** → scored on member count, reference count, last-activity timestamps. Delete is hard (no recovery).

Runs locally on a Mac Mini with a weekly launchd cron. One unified Slack DM summarizes every Sunday's run.

## Stack

- Next.js 16 (App Router, React 19)
- Prisma 7 + SQLite (`@prisma/adapter-better-sqlite3`)
- `@hubspot/api-client` with per-second retry/backoff + concurrency limit
- Tailwind 4 + Base UI / shadcn
- macOS launchd for scheduling, Slack Block Kit for summaries

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in HUBSPOT_ACCESS_TOKEN + optional Slack env
npx prisma migrate deploy
npx prisma generate
```

Required HubSpot Private App scopes:
- `crm.objects.contacts.read` / `write`
- `crm.objects.companies.read` / `write`
- `crm.objects.deals.read` *(for deal property audit)*
- `crm.lists.read` / `crm.lists.write` *(for list audit)*
- `automation` *(for workflow reference checking in property audit)*

Required env (see `.env.local.example` in the sanitized template):
- `HUBSPOT_ACCESS_TOKEN`
- `DATABASE_URL=file:./dev.db`
- `SLACK_BOT_TOKEN`, `SLACK_DM_USER_ID` *(only for weekly Slack DM)*
- `DEDUPE_DASHBOARD_URL` *(optional, default `http://localhost:3000`)*
- `DRY_RUN=true` *(optional, turns archive/delete actions into log-only no-ops)*

## Run locally

```bash
npm run dev
# → http://localhost:3000
```

From there:
- `/scan/new` — start a dedupe scan (contacts or companies)
- `/cleanup/properties/new` — start a property audit
- `/cleanup/lists/new` — start a list audit

## Run the unified weekly cron (one-off)

```bash
npm run weekly-cleanup
```

Triggers dedupe → property audit → list audit end-to-end and posts a single Slack DM.

## Install as a macOS launchd job (Sunday 2am)

```bash
bash scripts/launchd/install.sh
```

See [`DEPLOY-WEEKLY.md`](./DEPLOY-WEEKLY.md) for the full guide, troubleshooting, and migration notes (the old `com.yourorg.hubspot-dedupe` label auto-upgrades to `com.yourorg.hubspot-cleanup`).

## Project layout

```
prisma/schema.prisma           Data model (ScanRun, DuplicateGroup, GroupMember,
                               SuppressedPair, PropertyAuditRun, PropertyFinding,
                               SuppressedProperty, ListAuditRun, ListFinding,
                               SuppressedList)
src/lib/hubspot.ts             HubSpot API wrapper (pagination, rate limiting,
                               retry, canonical ID resolution, cleanup helpers)
src/lib/normalize.ts           Email / LinkedIn / phone / name normalization
src/lib/match.ts               Dedupe detection (tier 1–3 + conflict safety)
src/lib/merge.ts               Per-field merge strategies + PATCH-then-merge
src/lib/scanner.ts             Dedupe scan orchestrator
src/lib/cleanup-types.ts       Status / recommendation / thresholds constants
src/lib/cleanup-scoring.ts     scoreProperty, scoreList (pure functions)
src/lib/property-auditor.ts    Property audit lifecycle (runPropertyAudit)
src/lib/list-auditor.ts        List audit lifecycle (runListAudit)
src/lib/slack.ts               Block Kit formatters + postSlackDM
src/app/page.tsx               Home dashboard
src/app/scan/[id]/*            Dedupe review + actions
src/app/cleanup/**             Property + list audit review UIs
scripts/weekly-cleanup.ts      Unified weekly cron (dedupe + property + list)
scripts/weekly-dedupe.ts       Legacy dedupe-only cron (kept for reference)
scripts/launchd/               launchd plist + install script
```

## See also

- [`PLAN.md`](./PLAN.md) — original dedupe build plan + rule tables
- [`MERGE_RULES.md`](./MERGE_RULES.md) — per-field merge strategies
- [`DEPLOY-WEEKLY.md`](./DEPLOY-WEEKLY.md) — Mac Mini launchd deployment guide
