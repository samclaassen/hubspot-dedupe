# Weekly dedupe — Mac Mini deployment guide

Turn the one-off dedupe tool into a scheduled job that runs every Sunday at 2:00 AM, auto-merges high-confidence duplicates, and DMs you a summary in your Slack workspace.

**Who this is for:** whoever is running the dedupe tool. Everything below assumes you're sitting at (or SSH'd into) the Mac (Mini) where the tool will live long-term.

**What you need before starting:**

- A Slack app + bot token with `chat:write`, `im:write`, `users:read`, `users:read.email` scopes. See `.env.local.example` for the variables you'll populate.
- The bot authorized in your Slack workspace.
- A one-time test DM sent from the bot to yourself to confirm it works.

**What you're about to do:**

1. Sync the latest repo to the Mac Mini.
2. Add three env vars to `.env.local`.
3. Run a one-time DB migration.
4. Install the launchd job.
5. Do a manual test run.
6. Wait for Sunday 2 AM.

Total time: ~10 minutes.

---

## 0. Prerequisites (already met on the Mini)

- Node 25+ via Homebrew → `which node` should print `/opt/homebrew/bin/node`
- npm → `which npm` should print `/opt/homebrew/bin/npm`
- A working copy of the `hubspot-dedupe` repo → clone or rsync it to `~/hubspot-dedupe/` on the Mini

---

## 1. Sync the latest code from the laptop to the Mini

Run this command **from the laptop** (where the code changes were authored):

```bash
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'dev.db' \
  --exclude 'dev.db-journal' \
  "<PATH_TO_LOCAL_REPO>/hubspot-dedupe/" \
  <USERNAME>@<MAC_MINI_HOSTNAME>.local:~/hubspot-dedupe/
```

Replace:
- `<PATH_TO_LOCAL_REPO>` with the absolute path on the laptop (e.g. `~/code` or similar)
- `<USERNAME>` with the user account on the Mini
- `<MAC_MINI_HOSTNAME>` with whatever `hostname -s` prints on the Mini

Note: `dev.db` is excluded so the Mini's existing merged state stays intact. If you're starting fresh on the Mini and want the laptop's DB too, remove the `--exclude 'dev.db'` line.

If SSH isn't set up or the hostname differs, adjust accordingly.

---

## 2. Add three env vars on the Mini

SSH into the Mini (or sit at it), then edit the env file:

```bash
cd ~/hubspot-dedupe
nano .env.local
```

Add these three lines (the `HUBSPOT_ACCESS_TOKEN` and `DATABASE_URL` should already be in the file):

```
SLACK_BOT_TOKEN=<YOUR_SLACK_BOT_TOKEN>
SLACK_DM_USER_ID=<YOUR_SLACK_USER_ID>
DEDUPE_DASHBOARD_URL=http://localhost:3000
```

**Explanation of the three values:**

- `SLACK_BOT_TOKEN` — the Bot User OAuth Token from the "HubSpot Dedupe" Slack app (your workspace). Posts DMs via `chat.postMessage`.
- `SLACK_DM_USER_ID` — the Slack user ID that should receive the DM. Find yours via Slack → Profile → "Copy member ID".
- `DEDUPE_DASHBOARD_URL` — base URL for the review dashboard. Used to build "open dashboard" links in the Slack message. Leave as `http://localhost:3000` if you only ever open it on the Mini; set it to a tunnel URL if you expose the dashboard publicly.

Save the file (`Ctrl+O`, `Enter`, `Ctrl+X` in nano).

---

## 3. Install deps + run migrations

Still in `~/hubspot-dedupe` on the Mini:

```bash
npm install
npx prisma migrate deploy   # applies any pending schema migrations
npx prisma generate         # regenerates the Prisma client
```

`migrate deploy` is safe to re-run (it's a no-op if nothing's pending). We added a new `SuppressedPair` table earlier and the existing `dev.db` may or may not have it — this handles both.

---

## 4. Test the weekly script manually BEFORE scheduling it

This is the smoke test. **Highly recommended** before letting launchd run it unattended at 2am.

```bash
npm run weekly-dedupe
```

Expected behavior:

- Prints `[weekly-dedupe] starting…`
- Paginates all contacts (~3–5 minutes)
- Runs detection, filters out suppressed pairs, drops forward-refs
- Auto-merges ≥ 0.99 score groups (progress logged)
- Prints `[weekly-dedupe] Slack DM sent`
- Exits with code 0
- **You receive a DM from "HubSpot Dedupe" in your Slack workspace**

If the DM arrives, you're done with the hard part. If it errors out, see [Troubleshooting](#troubleshooting).

Because the tool now has the `SuppressedPair` table wired up and the forward-ref filter active, this first run should find **very few groups** (probably under 100) — most duplicates from today were already cleaned up.

---

## 5. Install the launchd schedule

Still from `~/hubspot-dedupe` on the Mini:

```bash
bash scripts/launchd/install.sh
```

The install script:

1. Computes the absolute repo path on this Mac.
2. Renders `scripts/launchd/com.yourorg.hubspot-dedupe.plist.template` with that path.
3. Copies the rendered plist to `~/Library/LaunchAgents/com.yourorg.hubspot-dedupe.plist`.
4. Unloads any prior version of the job.
5. Loads the new job via `launchctl bootstrap`.
6. Prints the job's status.

You should see:

```
✅ Installed. The job will run every Sunday at 2:00 AM local time.
```

### Verify it's scheduled

```bash
launchctl list | grep hubspot-dedupe
```

Should print something like:

```
-     0    com.yourorg.hubspot-dedupe
```

The first column is the PID (`-` means not currently running, which is correct). The middle column is the last exit code (0 = success). Once Sunday rolls around, you'll see non-dash values here during the run.

### Force a run right now (optional, definitive test)

```bash
launchctl kickstart -k gui/$(id -u)/com.yourorg.hubspot-dedupe
```

Then watch the logs:

```bash
tail -f ~/Library/Logs/hubspot-dedupe-weekly.log
```

You'll see the same output as step 4 above. This time it's running under launchd, so you know the scheduled version will work.

---

## 6. Done

That's it. Every Sunday at 2:00 AM:

- Mac Mini wakes up enough to fire the job (launchd handles this — no sleep config needed)
- Full scan + detection runs (~4 min)
- Auto-merge on high-confidence groups (~2–10 min depending on how many accumulated)
- You get a Slack DM around 2:10–2:15 AM
- Your HubSpot stays clean

Review any "needs review" groups at your leisure through the week. Each one you Skip becomes a `SuppressedPair` and won't come back in future scans.

---

## Optional: keep the dashboard accessible from anywhere

The launchd job doesn't need the web dashboard to be running — it operates directly against the DB and HubSpot. But you probably want the dashboard available for reviewing non-auto-merged groups.

Three options:

- **Only when you want it:** SSH to the Mini and `npm run dev` when you need to review. Kills when you close the SSH session.
- **Always running locally:** add another launchd job that keeps `next start` (the production server, which is more stable than `next dev` under tunnels) alive. Template available on request.
- **Public via Cloudflare tunnel:** like we did earlier today. Run `cloudflared tunnel --url http://localhost:3000` detached. Dashboard reachable from any browser.

Whichever you pick, make sure `DEDUPE_DASHBOARD_URL` in `.env.local` matches so the "open dashboard" link in Slack messages points to the right place.

---

## Monitoring

Three logs to watch:

| What | Where |
|---|---|
| stdout/stderr of the weekly run | `~/Library/Logs/hubspot-dedupe-weekly.log` |
| launchd's own logs about the job | `log show --last 1d --predicate 'subsystem == "com.apple.xpc.launchd"' | grep hubspot-dedupe` |
| Slack DMs | Your Slack DMs from the "HubSpot Dedupe" bot |

If something goes wrong at 2 AM on a Sunday, you'll know on Monday morning because either:

- No Slack DM arrived — check `~/Library/Logs/hubspot-dedupe-weekly.log` for the error
- A Slack DM with ❌ arrived — the error is in the message

---

## Troubleshooting

### "SLACK_BOT_TOKEN or SLACK_DM_USER_ID not set"

Env vars didn't load. Check `cat .env.local` has both lines without typos. `npm run weekly-dedupe` uses `tsx --env-file=.env.local`, so the file must be at the repo root.

### "prisma.$connect is not a function" or similar Prisma errors

Run `npx prisma generate` to regenerate the client. Happens if you forgot step 3 or if Prisma's generated output is corrupted.

### The job is scheduled but never runs

Possible causes:

1. **Mac was off at 2am and not set to wake up.** launchd fires calendar jobs as soon as the Mac wakes, so you'll get a delayed run when you boot it Monday. To force wake-on-schedule:

   ```bash
   sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
   ```

   This wakes the Mini at 1:55 AM every day — launchd fires the job 5 minutes later.

2. **Job failed at launch and launchd is throttling it.** `launchctl list | grep hubspot-dedupe` shows a non-zero exit code. Check the log for the actual error.

3. **Path issues under launchd.** launchd starts jobs with a minimal PATH. The plist sets `PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` but if Node is elsewhere on your machine, update the plist template.

### Node "Cannot find module" errors

Run `npm install` in the project dir. Native modules (better-sqlite3) need to be compiled for the Mac Mini's arch (arm64). If you rsync'd from an Intel Mac or a different Node version, nuke `node_modules/` and reinstall.

### Slack returns `channel_not_found`

The bot needs to have been added to the user's DM at least once, which happens automatically the first time it posts. But if the user ID is wrong, you'll see this. Double-check `SLACK_DM_USER_ID`:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/users.lookupByEmail?email=you.com"
```

The returned `user.id` should match `SLACK_DM_USER_ID` in `.env.local`.

### The scan finds way fewer groups than expected

This is expected after you've done an initial bulk cleanup. Once the big backlog is merged, a typical weekly run should find only 10–100 new groups (new records that came in since the previous scan).

If you want to sanity-check what the scanner is seeing, inspect the DB:

```bash
sqlite3 dev.db "SELECT status, COUNT(*) FROM DuplicateGroup WHERE scanRunId = (SELECT id FROM ScanRun WHERE ruleSet LIKE '%scheduled%' ORDER BY startedAt DESC LIMIT 1) GROUP BY status;"
```

### I Skipped a group by mistake and want it to come back

The pair is now in `SuppressedPair`. To un-suppress, delete those rows:

```bash
sqlite3 dev.db "DELETE FROM SuppressedPair WHERE idA = '<hubspot id>' OR idB = '<hubspot id>';"
```

Next scan will re-surface the group.

### I want to change the schedule (e.g., daily instead of weekly)

Edit `scripts/launchd/com.yourorg.hubspot-dedupe.plist.template` → the `StartCalendarInterval` section. Remove the `Weekday` key to run every day. Then re-run `bash scripts/launchd/install.sh`.

### Uninstall

```bash
launchctl bootout gui/$(id -u)/com.yourorg.hubspot-dedupe
rm ~/Library/LaunchAgents/com.yourorg.hubspot-dedupe.plist
```

Nothing else needs cleanup — all state is in `dev.db` which you can keep or delete.

---

## Appendix: what was actually built

For reference, here's what changed in the repo for this deployment:

| File | Purpose |
|---|---|
| `scripts/weekly-dedupe.ts` | CLI entry point. Orchestrates scan → auto-merge → Slack summary. |
| `src/lib/slack.ts` | Slack DM helper using `chat.postMessage` + Block Kit formatter. |
| `scripts/launchd/com.yourorg.hubspot-dedupe.plist.template` | launchd job spec, templated so it works on any path. |
| `scripts/launchd/install.sh` | One-shot install script. Renders template + bootstraps launchd. |
| `src/app/scan/[id]/actions.ts` — `skipGroup` | Now also writes to `SuppressedPair` table when you Skip. |
| `src/lib/scanner.ts` — `filterDetectedGroups` | New post-detection filter: drops suppressed pairs + forward-referenced records. |
| `src/lib/hubspot.ts` — `batchResolveCanonicalContactIds` | Batch API helper for canonical ID resolution (used for forward-ref filtering). |
| `src/app/page.tsx` — last scheduled run widget | Dashboard now shows last weekly run status at a glance. |
| `package.json` — `weekly-dedupe` script | `npm run weekly-dedupe` entry point. |

### Slack app details
- **Name:** HubSpot Dedupe (you can name it whatever)
- **Workspace:** your Slack workspace
- **Bot User:** e.g. `@hubspot_dedupe`
- **Scopes:** `chat:write`, `im:write`, `users:read`, `users:read.email`

Manage your Slack apps at: https://api.slack.com/apps

If the bot token ever leaks or needs rotating: Slack API page → OAuth & Permissions → "Rotate token". Then update `SLACK_BOT_TOKEN` in `.env.local` on the Mini.
