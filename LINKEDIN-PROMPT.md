# Build Your Own CRM Deduplication Tool — The Prompt

A ready-to-paste prompt for Claude Code (or any capable AI coding assistant) to build a tiered duplicate detection and merge tool for your CRM. Based on lessons learned building the same thing for HubSpot in a day — every "critical gotcha" section below is something that actually broke during the build.

Copy everything below the line into Claude Code and replace `<YOUR_CRM>` with HubSpot, Salesforce, Pipedrive, Attio, Zoho, or whatever you use.

---

## PROMPT START

I want you to build a local web application that scans my `<YOUR_CRM>` for duplicate contacts and companies, lets me review them, and merges them with per-field "combining" logic that preserves the best data from each record. This is for a one-time bulk cleanup, not an ongoing system. It runs on my laptop and connects to my CRM via a private API token.

### What the tool must do

**1. Connect to `<YOUR_CRM>` via a single API token** (read + write scope for contacts and companies). No OAuth, no multi-tenancy, no login screen. Token lives in `.env.local`.

**2. Run a full portal scan on demand:**
- Paginate through every contact and every company
- Pull only the properties needed for matching (not everything — it's slow and wastes rate limits)
- Store scan state and results in SQLite via Prisma
- Show live progress in the UI via polling

**3. Detect duplicates using a tiered rule system** (evaluate in order, highest tier wins, dedupe pairs across tiers):

**Tier 1 — Definitive rules (100% confidence, auto-merge eligible):**
- **Rule 1.1 — LinkedIn URL match:** pool all LinkedIn URL fields on each contact (there will be multiple — `linkedin_profile`, `linkedin_url`, enrichment vendor fields, etc.), normalize each to `linkedin.com/in/{slug}`, compare. Any slug overlap between two contacts = duplicate.
- **Rule 1.2 — Email match:** pool all email fields (`email`, `work_email`, `additional_emails`, enrichment fields), normalize each (lowercase, strip `+alias`, Gmail dot-stripping for `@gmail.com` and `@googlemail.com` only), compare. Any overlap = duplicate.

**Tier 2 — Composite rule (95% confidence, review recommended):**
- **Rule 2.1 — Name + Company:** both conditions must be true. Name match = exact on normalized `firstname + lastname`, OR fuzzy ≥92 (Jaro-Winkler or token_sort_ratio). Company match = same associated company ID, OR fuzzy ≥88 on normalized company free-text (strip legal suffixes like Inc, LLC, Ltd, GmbH).

**Tier 3 — Fuzzy scoring fallback (85% minimum, weighted):**
- Only runs on contacts NOT caught by Tier 1 or 2
- Weighted similarity across: firstname+lastname (0.5), company (0.3), phone (0.1, E.164 exact), jobtitle (0.1, partial ratio)
- Score = Σ(weight × similarity) / Σ(weights for fields with data on both)
- Thresholds: ≥0.99 auto-merge eligible, 0.85–0.99 review required, <0.85 not stored

**4. Use blocking to avoid n² comparisons.** Naive pairwise on 50k records is 1.25 billion compares — unworkable. Each contact goes into multiple blocks; comparisons only happen within a block:
- Normalized email → block
- Normalized LinkedIn slug → block
- `associatedcompanyid` → block (for Tier 2/3 within a company)
- `soundex(lastname) + firstname[0]` → block (fallback when no company association)

**5. Build a review dashboard:**
- KPI cards: Total groups / Merged / Skipped / Pending
- Filter tabs (Pending / Merged / Skipped / Failed / All)
- Paginated list (100 groups per page — never render all at once)
- Each group card shows: primary display name, number of duplicates, which tier matched, confidence score
- Click to expand: matched-on reason, "Select primary record" radio buttons, side-by-side property diff table highlighting differences
- Skip / Merge buttons per group with confirmation dialogs
- Bulk actions: "Skip All Pending", "Auto-merge All ≥99% confidence"

**6. Implement the merge execution flow correctly (this is where most tools get it wrong — see Critical Gotcha #2 below).**

### Merge rules — per-field "combining" strategies

When merging 2+ records, compute winning values across all of them using these defaults (they should be easy to configure later):

| Field | Strategy |
|---|---|
| email, work_email | `primary_if_not_empty` |
| firstname, lastname | `longest_non_empty` |
| phone | `valid_e164_first` |
| company, jobtitle | `most_recent_lastmodified` |
| LinkedIn URL fields | `first_non_empty` |
| createdate | `earliest` |
| Everything else | `primary_if_not_empty` (safe default) |

Strategy semantics:
- `primary_if_not_empty` — primary wins unless empty, then take first non-empty secondary
- `longest_non_empty` — longest non-empty string wins (e.g., "Catherine" beats "Cat")
- `most_recent_lastmodified` — whichever record has newer `hs_lastmodifieddate` (or your CRM's equivalent)
- `earliest` / `latest` — min/max for datetime fields
- `valid_e164_first` — E.164-formatted phone beats raw
- `first_non_empty` — non-empty value wins, primary preferred

### Primary record selection

Auto-pick the primary as: **most complete** (count of non-empty properties) → tiebreak **most recently modified** → tiebreak **oldest created**. User can override via radio buttons in the review UI.

### CRITICAL GOTCHAS — do not let me rediscover these the hard way

**Gotcha #1 — Use your CRM's basic List API, NOT the Search API, for full-portal pagination.** Most CRMs' search endpoints have a hard result cap (HubSpot's is 10,000; Salesforce's varies). You'll paginate fine for the first 100 pages and then hit a 400 error. Use the basic list endpoint (`GET /objects/{type}` with cursor pagination) which has no such cap. Search API is still fine for getting total counts (`limit=1` returns the total without paginating).

**Gotcha #2 — Your CRM's native merge API probably ignores per-field logic.** Most merge APIs simply keep the primary record's values and throw away secondaries. This means "prefer longest name" and "prefer most recent company" silently become lies. The correct pattern is:

```
1. Pick primary
2. Compute winning values across all records (per-field strategies)
3. PATCH primary with those winning values   ← DO NOT SKIP THIS STEP
4. Then call merge API
5. Record outcome
```

By the time the merge API runs, the primary already holds the winners. The secondaries get folded in with nothing to contribute on those fields. Without step 3, every "combining" rule in this spec is a lie.

**Gotcha #3 — Resolve canonical IDs at merge time, not scan time.** When records have been merged in the past, most CRMs keep the old IDs around as "forward references" — GET returns the canonical record transparently, but the merge API will refuse the old ID as a primary. Before merging, GET each record and use whatever ID the API returns in the response body. Dedupe the canonical set. If multiple input IDs resolve to the same canonical, those records were already merged by some other process — skip them.

**Gotcha #4 — Merge API needs higher scopes than basic write.** Your CRM's merge endpoint touches personally-identifiable fields and often requires "sensitive data write" or similar scopes on top of basic read/write. When you first create the API token, add ALL the write-related scopes for contacts and companies, not just the basic ones. HubSpot's failure mode is a 403 with "MISSING_SCOPES" — your CRM will have a similar error. Add scopes up front and save a round trip.

**Gotcha #5 — One concept, multiple fields.** Your CRM has LinkedIn URLs stored in 3+ different fields (native, enrichment vendor 1, enrichment vendor 2). Emails live in at least 2 (primary + work_email) and often more. Same for phone. **You must pool values from all relevant fields per record before running rules.** A match on any pooled value counts as a match. This single issue catches maybe 30% more real duplicates than single-field comparison.

**Gotcha #6 — Rate limits and concurrency.** Cap concurrent API requests (8 is safe). Exponential backoff on 429s and 5xxs. A full scan of 50k contacts is ~500 page reads; at 100 req/10s that's 50+ seconds minimum. Real-world 2–5 minutes. Progress UI must handle "this takes 5 min" gracefully.

**Gotcha #7 — Merges are irreversible.** Every merge button needs an explicit "This cannot be undone" confirmation dialog. Auto-merge bulk action needs an even scarier confirmation showing the count. Merged records can't be unmerged without recovery from an archive.

**Gotcha #8 — Don't render thousands of group cards at once.** Paginate server-side. A scan with 7,000 duplicate groups, rendered as a single HTML response, is 35+ MB and hangs most browsers. Server-filter by status + limit to 100 per page. Use URL search params (`?filter=pending&page=2`) so tab switching is a navigation, not client state.

**Gotcha #9 — Gmail dot-rule ONLY applies to Gmail.** `j.doe@gmail.com` = `jdoe@gmail.com`, but `j.doe@company.com` ≠ `jdoe@company.com`. Hardcode the gmail/googlemail domain check. Do not apply dot-stripping universally.

**Gotcha #10 — `+alias` stripping is sometimes wrong.** Many CRMs have power users (especially RevOps teams) who use `kate+tooltest@company.com` as per-tool tracking tags to know which signup came from which demo. Stripping `+alias` will collapse these into one "duplicate" when they're intentional. Make `+alias` stripping a configurable normalization flag, default on, but surface a warning when a group has many `+alias` emails.

### Suggested tech stack

- **Framework:** Next.js (App Router) + Tailwind + shadcn/ui
- **DB:** SQLite via Prisma (ample for 500k+ records, zero infra)
- **CRM SDK:** official SDK for your CRM (better than raw REST for types)
- **Fuzzy matching:** `fuzzball` (npm package with token_sort_ratio, token_set_ratio, partial_ratio)
- **Phone normalization:** `libphonenumber-js`
- **Domain parsing:** `psl` (public suffix list)
- **Rate limiting:** `p-limit` or `bottleneck`
- **Language:** TypeScript
- **Runs:** `npm run dev` on localhost. For a remote demo, use `next build && next start` (dev mode's streaming SSR breaks through Cloudflare tunnels).

### Build order — ship thin slices

Do not try to build everything at once. Each step should leave the app in a working state:

1. **Scaffold** — Next.js + Tailwind + shadcn/ui + Prisma + SQLite. Empty page at `/`. Done when `npm run dev` loads.
2. **CRM wrapper + real data on home** — Auth with the token, query total contacts count, show it on the home page. Done when the home page shows a real number from your CRM.
3. **Scan skeleton** — `/api/scan/start` creates a `ScanRun` row and kicks off a background paginator that just counts records. `/scan/[id]` polls `/api/scan/[id]/status` and shows progress. No matching yet.
4. **Tier 1 detection** — add normalization + email pooling + LinkedIn pooling. Populate `DuplicateGroup` + `GroupMember` rows. Done when a scan produces real duplicate groups.
5. **Review dashboard UI** — KPI cards, filter tabs, group list. No merge yet.
6. **Expand + diff table** — click to see matched-on reason + side-by-side property comparison + primary radio selector.
7. **Merge button** — confirmation dialog → server action that PATCHes primary then calls merge API → update DB. Done when v1 is shippable for contacts.
8. **Tier 2 + Tier 3 detection** — add name+company composite rule and fuzzy scoring fallback. Re-scan and verify.
9. **Companies support** — mostly a copy of contacts with different fields (domain + name). Most of the UI should already be generic over object type.
10. **Bulk auto-merge** — "Auto-merge All (N)" button that processes all pending groups with score ≥0.99 sequentially with progress reporting.

### Data model starting point

```prisma
model ScanRun {
  id              String    @id @default(cuid())
  objectType      String    // "contact" | "company"
  status          String    // "queued" | "running" | "complete" | "failed"
  stage           String?   // for progress UI
  recordsScanned  Int       @default(0)
  totalRecords    Int?
  groupsFound     Int       @default(0)
  startedAt       DateTime  @default(now())
  completedAt     DateTime?
  error           String?
  ruleSet         String    // JSON snapshot
  groups          DuplicateGroup[]
}

model DuplicateGroup {
  id             String    @id @default(cuid())
  scanRunId      String
  scanRun        ScanRun   @relation(fields: [scanRunId], references: [id], onDelete: Cascade)
  objectType     String
  matchTier      String    // "tier1_linkedin" | "tier1_email" | "tier2_name_company" | "tier3_fuzzy"
  matchScore     Float
  matchReasons   String    // JSON
  primaryId      String?   // user's chosen primary
  status         String    // "pending" | "merged" | "skipped" | "failed"
  decidedAt      DateTime?
  errorMessage   String?
  members        GroupMember[]
}

model GroupMember {
  id                 String         @id @default(cuid())
  groupId            String
  group              DuplicateGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  hubspotId          String         // your CRM's record ID
  propertiesSnapshot String         // JSON of properties at scan time
}
```

### Approach

Before you write any code, read my CRM's API documentation for:
1. Authentication (confirm I have the right scopes)
2. Pagination — check for result caps on search endpoints, find the basic list endpoint
3. Merge API — confirm the endpoint, confirm it's pairwise (1 primary + 1 secondary per call), confirm what fields it preserves
4. Properties API — list the actual field names for LinkedIn URL, email variants, phone, company, job title on contacts
5. Rate limits for my tier

Then sample ~10 real contacts to see the actual format of LinkedIn URLs, email variants, phone formats, and company field values in my data. Real data will teach you which normalization rules matter.

Build incrementally. After each step, verify against real data before moving on. Surface errors in the UI, don't hide them. When in doubt about a product decision (especially merge strategies), ask me rather than guessing.

Don't skip any of the 10 "critical gotchas" above. Every single one of them actually bit me during my own build. They are not theoretical.

## PROMPT END

---

## Suggestions for your LinkedIn post

Frame the post around the gotchas, not the feature list. "I built a CRM dedupe tool in a day — here are the 10 things I wish I'd known before I started" is a much stronger hook than "Look, I built a dedupe tool". The prompt itself goes in a code block at the bottom.

Lead with a concrete result: "Found 7,116 duplicate groups across 49,543 contacts in a 4-minute scan" is more compelling than "it works."

Call out the merge flow (Gotcha #2) specifically — it's the thing almost every "I vibe-coded a dedupe tool" demo gets wrong and it's the single biggest source of silent data loss in these tools.
