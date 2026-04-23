# Merge Rules — HubSpot Dedupe

How the dedupe tool combines duplicate records when you click Merge.

The short version: **partially-completed records get combined, not overwritten.** If Record A has an email but no phone, and Record B has a phone but no email, the merged record has both. Nothing valuable is thrown away.

---

## How it works

When you merge 2+ duplicate records, the tool runs this flow for each group:

```
1. Pick a primary record (the one that survives)
2. For each field, compute the winning value across all records
3. PATCH the primary record with those winning values
4. Call HubSpot's merge API to fold the secondaries into the primary
5. Record the outcome in the local DB
```

Step 3 is critical and is what makes field-level combining actually work — see [Why step 3 exists](#why-step-3-exists) below.

---

## Step 1 — How the primary is chosen

By default, the tool picks the primary automatically. You can override this in the review UI via the "Select primary record" radio buttons before clicking Merge.

The default pick order:

1. **Most complete** — the record with the most non-empty property values wins
2. **Tiebreak: most recently modified** — `hs_lastmodifieddate`
3. **Tiebreak: oldest created** — `createdate` (preserve longer history)

Rationale: the most-complete record carries the most data, so picking it as primary minimizes the amount of PATCHing we have to do in step 3 and minimizes the surface area for mistakes.

---

## Step 2 — Per-field combining rules

For each property on the record, the tool looks at ALL records in the duplicate group and picks a winner based on a **strategy** assigned to that field. Here's the current default table for contacts:

| Field | Strategy | Behavior |
|---|---|---|
| `email` | `primary_if_not_empty` | Primary's email wins. If primary's email is empty, take the first non-empty from secondaries. |
| `work_email` | `primary_if_not_empty` | Same logic |
| `firstname` | `longest_non_empty` | "Catherine" beats "Cat" beats "". Longest non-empty string wins. |
| `lastname` | `longest_non_empty` | Same |
| `phone` | `valid_e164_first` | A properly-formatted `+15551234567` wins over a raw `555-1234`. Falls back to non-empty primary. |
| `company` | `most_recent_lastmodified` | Whichever record was modified most recently wins — assumes newer data is better. |
| `jobtitle` | `most_recent_lastmodified` | Same logic |
| `linkedin_profile` | `first_non_empty` | Primary wins if not empty, else first non-empty secondary |
| `hs_linkedin_url` | `first_non_empty` | Same |
| `associatedcompanyid` | `primary_if_not_empty` | HubSpot's native merge unions company associations anyway |
| `createdate` | `earliest` | Preserve the oldest created date in history |
| *everything else* | `primary_if_not_empty` | Safe default — primary wins unless it's empty, then take from secondary |

For **companies**, the table is simpler:

| Field | Strategy |
|---|---|
| `name` | `longest_non_empty` |
| `domain` | `primary_if_not_empty` |
| `website` | `primary_if_not_empty` |
| `createdate` | `earliest` |

### Strategy vocabulary

| Strategy | What it does |
|---|---|
| `primary_if_not_empty` | Primary's value wins unless it's blank. If blank, take the first non-empty secondary. |
| `longest_non_empty` | Longest non-empty string wins across all records |
| `most_recent_lastmodified` | Whichever record has the newest `hs_lastmodifieddate` wins |
| `earliest` / `latest` | Min/max datetime across records (for date-typed fields) |
| `first_non_empty` | Primary preferred, but any non-empty secondary beats an empty primary |
| `valid_e164_first` | Properly-formatted E.164 phone beats a raw or malformed one |
| `sum` | Numeric addition across all records (not currently used; reserved for engagement counters) |

---

## Step 3 — Why step 3 exists (the critical piece)

**HubSpot's merge API doesn't let you pick winners per field.** It blindly uses the primary's current values for most fields. So if we just called the merge API directly, our field-level rules in step 2 would be a lie — the secondaries' better data would vanish.

To make the rules actually work, the tool:

1. Computes the winning values for every field (step 2)
2. **PATCH-updates the primary record** with those winning values before calling merge (step 3)
3. Then calls the merge API

By the time HubSpot's merge runs, the primary already holds the best combined values. The secondaries get folded in with nothing to contribute on those fields, which is exactly what we want.

**If you skip step 3, "prefer longest name" and "prefer most recent company" silently stop working** — the secondaries' better data just gets discarded.

---

## Concrete example

Two partially-completed records for the same person:

**Record A (70% complete — would be picked as primary):**
```
email      : john@acme.com
phone      : (empty)
firstname  : John
lastname   : Doe
company    : Acme
linkedin   : linkedin.com/in/jdoe
modified   : 2024-03-15
```

**Record B (60% complete):**
```
email      : (empty)
phone      : +15551234567
firstname  : Johnny
lastname   : Doe
company    : Acme Corporation
linkedin   : (empty)
modified   : 2026-01-10
```

After merge, the primary (Record A's ID survives) holds:

| Field | Value | Where it came from |
|---|---|---|
| email | `john@acme.com` | A (primary had it) |
| phone | `+15551234567` | **B** (primary was empty, valid_e164_first picked from B) |
| firstname | `Johnny` | **B** (longest_non_empty) |
| lastname | `Doe` | Either (same value) |
| company | `Acme Corporation` | **B** (most_recent_lastmodified — B modified 2026 > A modified 2024) |
| linkedin_profile | `linkedin.com/in/jdoe` | A (primary had it) |
| createdate | Whichever is older | `earliest` |

**Result:** every field is filled with the best available value. Nothing is lost.

---

## What HubSpot itself does automatically during merge

On top of the field-level rules above, HubSpot's native merge automatically handles these without needing any code from us:

- **Activity timelines** — emails, meetings, notes, calls from all records are union-merged onto the primary
- **List memberships** — unioned
- **Associations** — deals, companies, tickets associated with any record are preserved on the primary
- **Engagement metrics** (`hs_email_open`, `hs_email_click`, etc.) — HubSpot sums these across records
- **Secondary's email → `hs_additional_emails`** — if primary's email wins, the secondary's email isn't lost; HubSpot automatically adds it to the primary's additional emails list

So you never lose historical activity or relationships. The rules in this doc only decide the "primary writable field values" for the short list of identity-relevant fields (name, email, phone, company, etc.).

---

## Known limitations and future improvements

These are flagged for a v1.1 pass:

1. **`most_recent_lastmodified` uses record-level timestamps, not field-level.** `hs_lastmodifieddate` reflects when *any* field on the record was last touched. If Record B was modified last week because someone clicked an email, but Record B's `company` field hasn't changed in six months, we'd still say "B's company is more recent." To do this properly we'd need to query `propertiesWithHistory` from HubSpot and check the per-field timestamp. Not yet implemented.

2. **No user editor for strategies.** The defaults above are baked into code. If you want `email` to use `longest_non_empty` instead of `primary_if_not_empty`, someone has to edit `src/lib/merge.ts` today. A Settings page is a natural v1.1 addition.

3. **No "preview winners" column in the review UI.** The diff table shows each record's current values, but doesn't show "after merge, the primary will have THESE values." You have to mentally apply the rules while reviewing. Adding a computed "after-merge preview" column would make reviews much faster and safer.

4. **Multi-value field unioning isn't wired up.** The `union` strategy exists in the code as a concept but isn't assigned to any field. Fields that would benefit: custom multi-selects, tags, and HubSpot's list of additional emails (though HubSpot already handles the last one natively).

5. **Failed merges can be retried.** If a merge fails (e.g., missing scopes, HubSpot validation errors), the group stays in the Failed tab with the error surfaced inline. Clicking "Retry merge" runs the full pipeline again — including resolving canonical IDs, which protects against the case where records were silently re-merged by some other process between scan and review.

---

## Product decisions worth revisiting

A few defaults above are judgment calls where another choice would be equally reasonable. Worth a team discussion:

- **`email: primary_if_not_empty`** vs. `longest_non_empty` vs. "prefer a work-domain email over gmail." Today we keep primary's email unless empty; that's safe but may not reflect real preferences.
- **`company: most_recent_lastmodified`** — assumes newer is better. For a contact who changed jobs recently, this is correct. For a stale auto-populated company from an integration, it may not be. Consider adding a "prefer manually-set values" signal.
- **`firstname: longest_non_empty`** — "Catherine" beats "Cat" but also "Catherine Smith" beats "Catherine" if someone typed the full name into firstname. Maybe add a word-count cap or a sanity check.
- **Not currently merging: `hs_additional_emails`** — HubSpot handles this automatically during merge, but we could also explicitly compute and PATCH it in step 3 to be more defensive.

---

## Where this is implemented

- Strategy table: [`src/lib/merge.ts`](src/lib/merge.ts) → `CONTACT_STRATEGIES` and `COMPANY_STRATEGIES`
- Strategy implementations: `applyStrategy()` function in the same file
- Full execution flow: `executeMerge()` function
- Primary selection: `choosePrimary()` function
- Review UI with diff table: [`src/app/scan/[id]/group-card.tsx`](src/app/scan/%5Bid%5D/group-card.tsx)
