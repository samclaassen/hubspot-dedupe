# HubSpot Dedupe — Build Plan

Inspired by a similar dedupe side-project shared on LinkedIn. Two-phase build:

- **v1 (today):** One-off bulk dedupe of Contacts + Companies — connect → scan → review → merge
- **v2 (later):** Ongoing mode — webhooks + drift scans auto-queue new duplicates

Everything below is scoped to **v1**. v2 notes are in the final section.

---

## Build log

Key milestones + surprises from the build. See git history for details.

- **First scan result (Tier 1 only):** 1,218 duplicate groups across 49,543 contacts. 521 Tier 1.1 (LinkedIn) + 697 Tier 1.2 (Email). 2,766 records involved — ~5.6% duplication rate.
- **HubSpot Search API 10k cap:** Discovered at exactly record 10,001 — search API rejects pagination past 10,000 results. Switched to basic List API (`basicApi.getPage`) which has no such cap. ([src/lib/hubspot.ts](src/lib/hubspot.ts))
- **Prisma 7 adapter model:** New `prisma-client` provider requires explicit adapter on client construction. Using `@prisma/adapter-better-sqlite3`. ([src/lib/db.ts](src/lib/db.ts))
- **Base UI (not Radix):** shadcn/ui generator now emits Base UI primitives. `asChild` pattern doesn't work — use `render={<Button />}` instead.
- **A real user (name redacted) (12-dup group):** `+alias` stripping correctly collapsed `kate+X.com` addresses into one duplicate group. But she was intentionally using `+alias` as per-tool tracking tags. Real lesson: `+alias` stripping is sometimes wrong. Recommend making it a configurable normalization flag in v1.1.
- **Merge API 403 MISSING_SCOPES:** First real merge test failed because the Private App was missing `crm.objects.contacts.write` (the write scope was unchecked on the app, not a tier issue). HubSpot's error message listed 4 "requiredGranularScopes" as an OR condition — you only need ONE of them, and the plain `crm.objects.contacts.write` is sufficient. The error message is misleading about ALL vs ANY. Failed merges do NOT mutate any data — HubSpot rejects pre-commit.
- **Forward-reference merges (`VALIDATION_ERROR`):** Second merge attempt on the same group failed because HubSpot had already merged two of the three Example Name D records into a fourth canonical ID (`215803936944`) at some point after our scan. HubSpot's list API returns the *visible* ID for list entries, but those IDs can become "forward references" that transparently redirect reads to the canonical record. The merge API refuses to accept forward-ref IDs as primary. **Fix: resolve every record ID to its canonical form via a GET at merge time** (see `executeMerge` in [src/lib/merge.ts](src/lib/merge.ts#executeMerge)). The canonical ID is whatever `.id` HubSpot returns in the response body — it may differ from the ID you requested. Dedupe the canonical set before merging.

---

## Observed scale (live, 2026-04-15)

Queried via HubSpot Search API with our real Private App token:

| Object | Total | Has email | Has phone | Has firstname | Has lastname | Has company |
|---|---:|---:|---:|---:|---:|---:|
| **Contacts** | **49,540** | 44,513 (89.8%) | 11,765 (23.7%) | 44,512 (89.8%) | 44,725 (90.3%) | 40,044 (80.8%) |

| Object | Total | Has domain | Has name | Has website |
|---|---:|---:|---:|---:|
| **Companies** | **23,368** | 21,113 (90.3%) | 21,273 (91.0%) | 21,124 (90.4%) |

**LinkedIn URL fields on contacts** (discovered — multiple exist):

| Field | Populated | In use for matching? |
|---|---:|---|
| `hs_linkedin_url` | 26,484 | no (user choice — see Open decisions) |
| `linkedin_profile` | 20,959 | **yes** |
| `pb_linkedin_profile_url` | 3,368 | no (user choice) |
| `hs_linkedinid` | 0 | dead field |

Real format variations found in the data:
- `linkedin_profile`: `http://www.linkedin.com/in/dean-ramadan`, `https://www.linkedin.com/in/isaac-ware/`, `linkedin.com/in/brandeesanders`
- `hs_linkedin_url` (not used): `https://linkedin.com/in/dean-ramadan`

Must normalize before compare — raw strings won't match.

**Email fields on contacts** (multiple exist):

| Field | Populated | In use for matching? |
|---|---:|---|
| `email` | 44,513 | **yes** (primary) |
| `exactbuyer_current_work_email` | 3,435 | no (user choice) |
| `work_email` | 1,328 | **yes** |
| `hs_additional_emails` | 547 | no (user choice) |
| `pb_email` | 0 | dead field |

Pooled email coverage = 45,841 contacts (some overlap between `email` and `work_email`).

**Company association sources on contacts:**

| Field | Populated | Notes |
|---|---:|---|
| `associatedcompanyid` | 37,823 (76%) | ID-based, authoritative |
| `company` (free text) | 40,044 (81%) | String — noisy, needs fuzzy match |

**Implications for the plan:**
- **~3x smaller than Brandon's 131k screenshot.** The scan will be minutes, not hours.
- **Email coverage is excellent (89.8%)** — it's a reliable blocking key for contacts. Almost every contact can be placed in an email-based block.
- **Phone coverage is poor (23.7%)** — usable as a *secondary* match signal but not as a blocking key. Drop its weight in the default rule set.
- **Domain coverage on companies is excellent (90.3%)** — ideal blocking key.
- **Scan time estimate at HubSpot rate limits:**
  - Contacts: 495 page reads at 100/10s = ~50s minimum, realistically 1–3 min with backoff
  - Companies: 234 page reads = ~25s minimum, realistically 30s–1 min
  - **Total: well under 5 minutes for a full portal scan**
- **Matching CPU cost** is trivial with blocking: naive is `49,540² ≈ 2.4B compares`, but email-blocked is more like ~10k compares — sub-second.

---

## v1 Goal

Replicate the screenshot from Brandon's post for our own HubSpot portal:

- Connect HubSpot (Private App token, single portal)
- Pick object (Contacts or Companies)
- Configure match rules (exact on email/domain, fuzzy on name)
- Run a full scan (49,540 contacts + 23,368 companies — see Observed scale above)
- Review duplicate groups in a dashboard with KPI cards, filter tabs, side-by-side diff, and Skip/Merge buttons
- Auto-merge all 100% matches in bulk, or review 1:1
- Execute merges via HubSpot's merge API

No webhooks. No cron. No multi-tenant auth. No cloud hosting. Runs on `localhost:3000`.

---

## Non-goals for v1

- Ongoing/real-time dedup (that's v2)
- Deals dedup
- Merging across object types
- HubSpot Marketplace listing
- Production deployment / multi-user
- Undo of merges (HubSpot's merge is one-way — make this explicit in the UI)

---

## Stack

Minimal and local-first:

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 (App Router) | API routes + React UI in one process |
| UI | Tailwind + shadcn/ui | KPI cards, tabs, tables, dialogs come pre-built — matches the screenshot |
| DB | SQLite via Prisma | No Docker, no Postgres setup, file-based, portable |
| HubSpot SDK | `@hubspot/api-client` | Official, handles pagination + retry primitives |
| Matching | `fuzzball` (fuzzy strings) + `libphonenumber-js` (phone) + `psl` (domain roots) | Battle-tested, small deps |
| Language | TypeScript | |
| Node | 20+ | |

**Not using (and why):** Redis/BullMQ (overkill locally), Postgres (SQLite is enough for one user), OAuth (Private App token is 1 env var), separate worker process (scan runs in a background Node task inside the Next.js process).

---

## Architecture

```
┌─────────────────────────────────────────┐
│ Next.js app (localhost:3000)            │
│                                         │
│  ┌──────────────┐    ┌──────────────┐   │
│  │  UI (React)  │───▶│  API routes  │   │
│  │  /           │    │  /api/scan   │   │
│  │  /scan/new   │    │  /api/merge  │   │
│  │  /scan/[id]  │    │  /api/rules  │   │
│  └──────────────┘    └──────┬───────┘   │
│                             │           │
│                             ▼           │
│                      ┌─────────────┐    │
│                      │  lib/       │    │
│                      │  hubspot.ts │    │
│                      │  match.ts   │    │
│                      │  scanner.ts │    │
│                      └──────┬──────┘    │
│                             │           │
│                             ▼           │
│                      ┌─────────────┐    │
│                      │  SQLite     │    │
│                      │  (Prisma)   │    │
│                      └─────────────┘    │
└─────────────────────────────────────────┘
              │
              ▼
       ┌─────────────┐
       │  HubSpot    │
       │  REST API   │
       └─────────────┘
```

Scans run as a detached async function inside the Next.js process (started by `/api/scan/start`, writes progress to SQLite, UI polls `/api/scan/[id]/status` every 2s). Good enough for one user on localhost; trivially upgraded to a real queue in v2.

---

## Data model (Prisma schema sketch)

```prisma
model ScanRun {
  id              String   @id @default(cuid())
  objectType      String   // "contact" | "company"
  status          String   // "running" | "complete" | "failed"
  recordsScanned  Int      @default(0)
  totalRecords    Int?
  groupsFound     Int      @default(0)
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  error           String?
  ruleSet         Json     // snapshot of rules used
  groups          DuplicateGroup[]
}

model DuplicateGroup {
  id             String   @id @default(cuid())
  scanRunId      String
  scanRun        ScanRun  @relation(fields: [scanRunId], references: [id])
  objectType     String
  matchScore     Float    // 0.0 - 1.0
  matchReasons   Json     // e.g. {"email": "exact", "name": "fuzzy:0.92"}
  primaryId      String?  // user's pick (defaults to newest or most-complete)
  status         String   // "pending" | "merged" | "skipped"
  decidedAt      DateTime?
  members        GroupMember[]
  @@index([scanRunId, status])
}

model GroupMember {
  id                 String  @id @default(cuid())
  groupId            String
  group              DuplicateGroup @relation(fields: [groupId], references: [id])
  hubspotId          String
  propertiesSnapshot Json    // {email, firstname, lastname, ...}
  @@index([groupId])
}

model RuleSet {
  id         String   @id @default(cuid())
  name       String
  objectType String
  rules      Json     // [{property: "email", type: "exact", weight: 1.0}, ...]
  threshold  Float    // 0.85
  createdAt  DateTime @default(now())
}
```

---

## Detection Rules (confirmed 2026-04-15)

Tiered system — evaluate in order, short-circuit on the highest-confidence match, fall through to fuzzy scoring only for records that weren't caught by a definitive rule.

### Contact fields we match on (confirmed by user)

| Rule input | Fields pooled | Populated |
|---|---|---:|
| LinkedIn URL | `linkedin_profile` | 20,959 |
| Email | `email`, `work_email` | 45,841 unique contacts |
| Name | `firstname`, `lastname` | 44,512 / 44,725 |
| Company (assoc.) | `associatedcompanyid` | 37,823 |
| Company (text) | `company` | 40,044 |
| Phone | `phone` | 11,765 |
| Job title | `jobtitle` | (not yet measured) |

### Tier 1 — Definitive rules (100% confidence, auto-merge eligible)

Any ONE triggers a duplicate match. Rules 1.1 and 1.2 evaluate independently — **missing data in one field does NOT block a match from another**. A contact with an email but no LinkedIn URL can still match another contact via Rule 1.2; a contact with a LinkedIn URL but no email can still match via Rule 1.1.

**Rule firing matrix** (asymmetric cases are the common ones in messy CRMs):

| Contact A | Contact B | Rule that fires | Duplicate? |
|---|---|---|---|
| email `x`, LI `y` | email `x`, LI `y` | 1.1 + 1.2 | ✓ |
| email `x`, **no LI** | email `x`, **no LI** | 1.2 | ✓ |
| email `x`, LI `y` | email `x`, **no LI** | 1.2 | ✓ (asymmetric) |
| **no email**, LI `y` | **no email**, LI `y` | 1.1 | ✓ |
| email `x`, LI `y` | email `z` (different), LI `y` | 1.1 | ✓ (person changed email) |
| `email = x` on A | `work_email = x` on B | 1.2 (cross-field pool) | ✓ |
| email `x`, **no LI** | email `z` (different), LI `y` | neither | → Tier 2/3 |

**Rule 1.1 — LinkedIn URL**
- Per contact, read `linkedin_profile`
- Normalize to canonical slug: `linkedin.com/in/{slug}`
  - lowercase
  - strip protocol (`http://`, `https://`)
  - strip `www.`
  - strip trailing slash
  - strip query string and fragment
  - extract the segment after `/in/`
- If Contact A's normalized slug equals Contact B's slug → **duplicate**

```ts
// example
"https://www.linkedin.com/in/isaac-ware/?utm=x"  →  "linkedin.com/in/isaac-ware"
"http://www.linkedin.com/in/isaac-ware"          →  "linkedin.com/in/isaac-ware"
"linkedin.com/in/isaac-ware"                     →  "linkedin.com/in/isaac-ware"
```

**Rule 1.2 — Email**
- Per contact, pool all values from `email` and `work_email`
- Normalize each:
  - lowercase
  - for `@gmail.com` / `@googlemail.com` only: strip dots in local part
  - for all domains: strip `+alias` from local part
- If any email in A's pooled set equals any email in B's pooled set → **duplicate**

```ts
// example — these are all the same
"John.Doe+newsletter@gmail.com"  →  "johndoe@gmail.com"
"johndoe@gmail.com"              →  "johndoe@gmail.com"
"JohnDoe@Gmail.com"              →  "johndoe@gmail.com"
```

### Tier 2 — Composite rule (high confidence, review recommended)

**Rule 2.1 — Name AND Company**
Both conditions must be true:

1. **Names match:**
   - Exact on `normalize(firstname + " " + lastname)` (lowercase, strip titles/punctuation), OR
   - `fuzzball.token_sort_ratio ≥ 92`

2. **Company match (either method):**
   - Same `associatedcompanyid`, OR
   - `fuzzball.token_set_ratio` of normalized `company` free-text ≥ 88
   - Company normalization: lowercase, strip legal suffixes (Inc, LLC, Ltd, Co, GmbH, etc.), strip punctuation

Confidence starts at ~0.95 (not 1.0 — "John Smith at IBM" isn't unique).

### Tier 3 — Fuzzy scoring (only for records not caught by Tier 1 or 2)

Weighted similarity across multiple properties. Runs only on contacts without a LinkedIn URL AND without a matched email:

| Property | Weight | Similarity metric |
|---|---:|---|
| firstname + lastname | 0.5 | `fuzzball.token_sort_ratio` |
| company (normalized) | 0.3 | `fuzzball.token_set_ratio` |
| phone (E.164) | 0.1 | exact |
| jobtitle | 0.1 | `fuzzball.partial_ratio` |

```
score = Σ(weight × similarity) / Σ(weight where both records have the field)
```

Thresholds (user-tunable in scan config):
- `≥ 0.99` → auto-merge eligible
- `0.85 – 0.99` → review required
- `< 0.85` → not stored

### Normalization reference

| Property | Rule |
|---|---|
| LinkedIn URL | lowercase → strip protocol → strip `www.` → strip trailing slash → strip query/hash → extract `/in/{slug}` |
| Email | lowercase → Gmail dot-stripping (gmail/googlemail only) → strip `+alias` |
| Phone | `libphonenumber-js` → E.164 |
| Person name | lowercase → strip titles (Mr/Mrs/Ms/Dr/Prof) → strip punctuation → collapse whitespace |
| Company name | lowercase → strip legal suffixes (Inc/LLC/Co/Ltd/GmbH/SA/SAS/Pty) → strip punctuation |
| Domain | lowercase → strip `www.` → take registered domain via `psl` |

### Blocking strategy (avoids n²)

Naive pairwise on 49,540 contacts = 2.4B compares. Unworkable. We place each contact into multiple blocks and only pairwise-compare within a block:

| Block key | Catches | Est. block count |
|---|---|---:|
| Normalized LinkedIn slug | Rule 1.1 | ~20k singletons, ~500 with collisions |
| Normalized email | Rule 1.2 | ~45k singletons, ~1k with collisions |
| `associatedcompanyid` | Rules 2.1 / 3 (same company) | ~38k entries, larger blocks per company |
| `soundex(lastname) + firstname[0]` | Rules 2.1 / 3 (no association) | fallback |

A contact goes into every block it qualifies for. A pair might be flagged by multiple blocks — we dedupe by normalizing pair ordering (`min(id), max(id)`) and keep the higher-confidence match.

Estimated total pairwise compares: **~80k**. Sub-2-second scoring pass.

### Rule precedence and confidence

When a pair matches multiple rules, the highest-tier match wins. Confidence is set by the winning rule:

| Winning rule | Confidence | Auto-merge eligible? |
|---|---:|---|
| Tier 1.1 — LinkedIn URL | 1.00 | yes |
| Tier 1.2 — Email | 1.00 | yes |
| Tier 2.1 — Name + Company | 0.95 | no (review) |
| Tier 3 — Fuzzy ≥ 0.99 | 0.99 | yes |
| Tier 3 — Fuzzy 0.85–0.99 | score | no (review) |

---

## Merge Rules

**Critical insight:** HubSpot's `/crm/v3/objects/contacts/merge` API does NOT let you pick winning values per field. It takes the primary record's current values for most fields. So our "merge rules" can't live inside the merge call — we have to set the primary record's values *before* calling merge.

### Actual merge flow

```
1. Pick primary record (most complete → most recently modified → oldest)
2. For each field, compute the winning value using the rule table below
3. For each field where winning value ≠ primary's current value:
       PATCH primary record to set the winning value
4. Call merge API: POST /crm/v3/objects/contacts/merge
   body: { primaryObjectId, objectIdToMerge }
5. Record the outcome (success / failure / fields patched / merged IDs)
```

Without step 3, any "prefer longest name" or "prefer most recent company" rule is a lie.

### Primary record selection (default, user can override in review UI)

Scoring order:
1. **Completeness** — count of non-empty custom properties
2. **Tiebreak 1** — most recent `hs_lastmodifieddate`
3. **Tiebreak 2** — oldest `createdate` (longer history)

### Per-field winner strategies (defaults)

| Field | Strategy | Rationale |
|---|---|---|
| `email` | `primary_if_not_empty` | Don't nuke primary's email; fall back if primary is empty |
| `work_email` | `primary_if_not_empty` | Same |
| `firstname`, `lastname` | `longest_non_empty` | "Cat" < "Catherine" |
| `phone` | `valid_e164_first` | Formatted number beats raw |
| `company` | `most_recent_lastmodified` | Latest intel wins |
| `jobtitle` | `most_recent_lastmodified` | Same |
| `linkedin_profile` | `first_non_empty` | They're the same human |
| `hs_linkedin_url` | `first_non_empty` | Same (still stored even if not matched on) |
| `associatedcompanyid` | `primary_if_not_empty` | HubSpot unions associations anyway |
| Any `hs_email_first_*` datetime | `earliest` | First touch shouldn't move forward |
| Any `hs_email_last_*` datetime | `latest` | Last touch shouldn't move back |
| Numeric engagement metrics (`hs_email_open`, `hs_email_click`, etc.) | `sum` | Totals should add — NOTE: HubSpot already does this during merge, don't double-count |
| `createdate` | `earliest` | Take the older creation date |
| Enumeration fields | `primary_if_not_empty` | Safe default |
| Custom string fields | `primary_if_not_empty` | Safe default |
| Everything else | `primary_if_not_empty` | Safe default |

### Winner strategy definitions

```ts
type MergeStrategy =
  | "primary_if_not_empty"    // primary wins unless empty, then secondary
  | "longest_non_empty"       // longer string wins; non-empty tiebreaker
  | "most_recent_lastmodified"// record with newer hs_lastmodifieddate wins
  | "earliest"                // min datetime
  | "latest"                  // max datetime
  | "sum"                     // numeric addition
  | "union"                   // combine to set/list
  | "first_non_empty"         // non-empty, primary tiebreaker
  | "valid_e164_first"        // E.164 valid wins; falls back to non-empty
```

Stored as per-field config, editable in the Settings page post-v1. For v1 we ship these defaults and skip the editor UI.

### Merge execution rules

- **N-way duplicates:** process pairwise. Group A+B+C with primary A:
  1. Compute winners across A+B → PATCH A → merge(A, B) → refresh A
  2. Compute winners across (new A)+C → PATCH A → merge(A, C)
  3. Record as a single group decision.
- **Refresh between merges:** after each HubSpot merge call, re-fetch the primary record so subsequent field computations use the post-merge state.
- **Merge API rejections:** 400s from HubSpot (e.g., secondary already merged elsewhere) → mark group `failed`, store error message, do not retry, user investigates.
- **Pre-merge safety check:** before calling merge, verify both records still exist and neither has been merged since the scan. If either failed, mark group `stale` and require re-scan.

### Edge cases

1. **Merge API requires primary and secondary to be the same object type.** Contacts merge with contacts, companies with companies. No cross-object merging.
2. **HubSpot audit trail:** merges are logged in the activity feed and are effectively irreversible (undo requires manual recovery from an archive). We surface this in the UI with a scary confirm dialog.
3. **Lists and workflows:** HubSpot handles list memberships during merge (unions them). We don't need to touch this.
4. **Custom objects / deals / tickets:** associations are preserved via HubSpot's native merge. We don't need to manage them.
5. **Conflicting emails across records:** both survive — primary keeps its `email`, secondary's email moves to `hs_additional_emails` automatically (HubSpot's default). Nothing lost.

---

## Edge cases for detection (separate from merge edge cases)

1. **Same LinkedIn URL across different humans** (rare): consultant aliases, parents/kids. User skips in review → store permanently → exclude from future scans via a `suppressed_pairs` table.
2. **Different LinkedIn URLs in the same record** (real case in the data — `hs_linkedin_url: hpinaud` vs `linkedin_profile: hallyp`): not our problem to resolve; we only pool `linkedin_profile` per the user's choice, so this specific case is not a trigger. If user later enables pooling of `hs_linkedin_url`, we flag for review, don't auto-merge.
3. **Gmail dot-rule only applies to Gmail.** `j.doe@gmail.com` = `jdoe@gmail.com`, but `j.doe@company.com` ≠ `jdoe@company.com`. Hardcode the gmail/googlemail domain check.
4. **Tier 3 false positives at scale:** default fuzzy threshold is 0.85 but offer a slider (0.75–0.99) in the scan config. Users can tune post-scan.

---

## HubSpot API specifics

- **Auth:** HubSpot Private App token in `HUBSPOT_ACCESS_TOKEN` env var. Single portal. Docs: https://developers.hubspot.com/docs/api/private-apps
- **Required scopes:** `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.companies.write`
- **Pagination — MUST use basic List API, NOT Search.** Discovered at 10,000 records during first real scan: HubSpot's Search API (`/crm/v3/objects/{obj}/search`) has a **hard 10,000 result cap** — pagination fails with 400 past that. Use the basic list endpoint (`/crm/v3/objects/{obj}` → SDK `basicApi.getPage`) for full-portal scans. Still 100 records/page with `after` cursor, but no row cap. Only request properties we match on. Search API is still fine for *total count* queries (`limit: 1` returns `total` without paginating).
- **Merge:** `POST /crm/v3/objects/{obj}/merge` takes `{primaryObjectId, objectIdToMerge}`. Pairwise only — a group of 3 = 2 merge calls. **Merges are irreversible.** Surface this clearly in the UI before any destructive action.
- **Rate limits:** 100 req/10s for standard portals, 190 for Enterprise. Must implement exponential backoff on `429`. Use `p-limit` or `bottleneck` to cap in-flight requests.

---

## UI (matching Brandon's screenshot)

### Pages

| Route | Purpose |
|---|---|
| `/` | Connection status + list of past scans + "New Scan" CTA |
| `/scan/new` | Pick object (Contacts / Companies) + match rule config + "Start Scan" |
| `/scan/[id]` | The main review dashboard (the screenshot) |
| `/settings` | Rules library |

### `/scan/[id]` layout

```
┌──────────────────────────────────────────────────────────┐
│  [logo] Dedupe        Dashboard  + New Scan      user ▼  │
├──────────────────────────────────────────────────────────┤
│  Dashboard > Review: Companies                           │
│                                                          │
│  Review Duplicates: Companies          [ + New Scan  ]   │
│  Scan complete. Found 1,432 groups across 131,865 rec.   │
│                                                          │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                  │
│  │ 1432 │  │  1   │  │  0   │  │ 1431 │                  │
│  │Groups│  │Merged│  │Skip. │  │Pend. │                  │
│  └──────┘  └──────┘  └──────┘  └──────┘                  │
│                                                          │
│  Show: [Pending] Merged Skipped All   [Skip All][Auto-M] │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ▼ Company A - Company A  •  2 recs  •  100% match  │  │
│  │                              [ Skip ] [ Merge ]    │  │
│  │   SELECT PRIMARY RECORD (KEPT AFTER MERGE)         │  │
│  │   [● Company A #100001 ] [○ Company A #100002 ]    │  │
│  │   Property    | Record 1     | Record 2            │  │
│  │   Record ID   | #100001      | #100002             │  │
│  │   Created     | 3/12/2026    | 9/16/2019           │  │
│  │   name        | Company A    | Company A           │  │
│  │   domain      | company-a.com| companya.com  [diff]│  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ▶ Company B - Company B  •  2 recs  •  100% match  │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Components (shadcn/ui)

- KPI cards → `Card` with big number
- Filter tabs → `Tabs`
- Group row → `Collapsible` + custom header
- Diff table → custom `<PropertyDiffTable>` that highlights cells where values differ
- Primary selector → `RadioGroup`
- Merge confirm → `AlertDialog` ("This cannot be undone. Merge Company A #100001 into...?")
- Bulk actions → `Button` + `AlertDialog`

---

## Build order (ship thin slices — 10 steps)

Each step should leave the app in a working state. Aim to finish steps 1–7 today for v1.

1. **Scaffold.** `create-next-app` TS + Tailwind. Add shadcn/ui. Add Prisma + SQLite. Empty page at `/`. ✅ = `npm run dev` loads a blank page.
2. **HubSpot auth.** Drop token in `.env.local`. Build `lib/hubspot.ts` with a wrapper that auth-ed GETs `/crm/v3/objects/contacts?limit=10`. Show the list on `/`. ✅ = real HubSpot contacts on screen.
3. **Prisma + scan skeleton.** Migrate. Build `/api/scan/start` route that creates a `ScanRun` row and kicks off an async scanner (no matching yet, just paginate + count). UI on `/scan/new` with a "Start Scan" button. `/scan/[id]` shows progress (polls status every 2s). ✅ = can run a scan that counts all contacts.
4. **Exact-match detection.** Add `lib/match.ts` with normalize + simple "same normalized email = duplicate" rule. Populate `DuplicateGroup` + `GroupMember`. ✅ = scan produces real duplicate groups.
5. **Review dashboard UI.** Build `/scan/[id]` with KPI cards, filter tabs, and a list of group cards (collapsed by default). No merge yet. ✅ = dashboard looks like the screenshot.
6. **Expand + diff.** Expanding a group shows the property diff table + primary-record selector. ✅ = side-by-side compare works.
7. **Merge.** "Merge" button → `AlertDialog` → `POST /api/scan/[id]/groups/[gid]/merge` → calls HubSpot merge API → updates group status to `merged`. Same for Skip (no API call, just DB update). ✅ = **v1 is shippable for contacts.**
8. **Fuzzy matching.** Add `fuzzball` token_set_ratio for names. Add threshold slider to `/scan/new`. Re-scan to verify. ✅ = finds near-duplicates.
9. **Companies.** Duplicate the code path with company fields (domain, name). Most of the work is in `lib/match.ts` — the UI should already be generic over `objectType`. ✅ = full v1 coverage.
10. **Bulk auto-merge.** "Auto-merge All (N)" button on the dashboard → `AlertDialog` → `POST /api/scan/[id]/auto-merge` → loops through all groups with score ≥ 0.99 and merges them, reporting progress. ✅ = **v1 done.**

---

## File layout

```
HubSpot Dedupe/
├── PLAN.md                    ← this file
├── .env.local                 ← HUBSPOT_ACCESS_TOKEN (gitignored)
├── .gitignore
├── package.json
├── tsconfig.json
├── next.config.js
├── tailwind.config.ts
├── prisma/
│   ├── schema.prisma
│   └── dev.db                 ← SQLite file (gitignored)
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx           ← home / connection / scan list
│   │   ├── scan/
│   │   │   ├── new/page.tsx
│   │   │   └── [id]/page.tsx  ← the review dashboard
│   │   └── api/
│   │       └── scan/
│   │           ├── start/route.ts
│   │           └── [id]/
│   │               ├── status/route.ts
│   │               ├── groups/route.ts
│   │               ├── groups/[gid]/merge/route.ts
│   │               ├── groups/[gid]/skip/route.ts
│   │               └── auto-merge/route.ts
│   ├── lib/
│   │   ├── hubspot.ts         ← SDK wrapper + rate limit handling
│   │   ├── match.ts           ← normalize + score
│   │   ├── scanner.ts         ← scan orchestrator (paginate + block + score + persist)
│   │   ├── db.ts              ← prisma client singleton
│   │   └── merge.ts           ← merge executor
│   └── components/
│       ├── KpiCard.tsx
│       ├── ScanFilters.tsx
│       ├── GroupCard.tsx
│       ├── PropertyDiffTable.tsx
│       └── MergeConfirmDialog.tsx
```

---

## Risks / things to watch

1. **Rate limits on large scans.** 49,540 contacts + 23,368 companies at 100/req = 729 reads combined. At 100 req/10s, that's ~73s minimum. Real-world 3–5 min with retries. Progress UI should still handle "this takes 5 min" gracefully.
2. **Merges are irreversible.** Every merge button needs an explicit confirm. Auto-merge should have a big "this will merge N records permanently" dialog.
3. **Property snapshots can go stale.** If a user runs a scan, takes lunch, comes back and merges — the on-screen data may be outdated. For v1, note the scan time prominently. v2 can re-fetch before merge.
4. **Gmail dot-normalization is a trap.** `j.doe@gmail.com` and `jdoe@gmail.com` are the same inbox, but `j.doe@otherdomain.com` is not. Only apply the dot rule to `@gmail.com` / `@googlemail.com`.
5. **Fuzzy thresholds are subjective.** Default to 0.85 but show the slider — different teams will want different cutoffs.
6. **HubSpot merge API can reject merges** (e.g., if one record is already merged). Handle 400s gracefully and surface them in the UI.

---

## v2 notes (out of scope for today, here for continuity)

When we come back to add ongoing mode:

- **Auth upgrade:** Private App → HubSpot Developer App (required for webhooks)
- **Webhook endpoint:** `/api/webhooks/hubspot` receives `contact.creation`, `company.creation`, `contact.propertyChange` (email), `company.propertyChange` (domain)
- **New-duplicate inbox:** on webhook, run match against existing records. If score ≥ threshold, create a `DuplicateGroup` with `source: "realtime"` and surface in a new dashboard page `/inbox`.
- **Auto-merge tier:** if score ≥ 0.99 AND user has enabled auto-merge, merge immediately. Else queue for review.
- **Drift scan:** nightly cron (Inngest / node-cron) that runs a partial scan on records created in the last 24h to catch webhooks that were missed / delayed / batched.
- **Queue upgrade:** swap in-process async for BullMQ + Redis (Upstash free tier). Needed because webhooks fire while scans are also running.
- **Deploy:** Vercel (UI + API) + Railway/Fly (worker) + Upstash Redis + Supabase Postgres (swap SQLite → Postgres). ~$0–20/mo.

---

## Open decisions for v1

None blocking — these can be decided as we build or after the first scan:

- [ ] **LinkedIn fields to pool** — currently only `linkedin_profile` (20,959 records) per user choice. Consider adding `hs_linkedin_url` (26,484 records) after first scan if we're missing obvious dupes. Would catch ~5k additional potential matches if the fields aren't fully redundant.
- [ ] **Email fields to pool** — currently `email` + `work_email` (45,841 records) per user choice. Consider adding `exactbuyer_current_work_email` (3,435) and `hs_additional_emails` (547) after first scan.
- [ ] **Fuzzy threshold** — default 0.85 for review. May need to tune post-scan based on precision/recall on real results.
- [ ] **Primary record selection tiebreakers** — current order: most-complete → most-recent-modified → oldest-created. Could add "has valid LinkedIn URL" or "has phone" as additional tiebreakers.
- [ ] **Whether to show scan progress as a % or just "X of Y records scanned"**
- [ ] **Theme** — match an existing brand palette or pick your own
