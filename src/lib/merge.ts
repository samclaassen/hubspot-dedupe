// Merge executor — see PLAN.md § Merge Rules.
// Critical: we PATCH the primary record with winning field values BEFORE
// calling HubSpot's merge API, because the merge API takes primary's values
// for most fields. Without this, any "longest_non_empty" or
// "most_recent_lastmodified" rule is a lie.

import { hubspot } from "@/lib/hubspot";

type MergeStrategy =
  | "primary_if_not_empty"
  | "longest_non_empty"
  | "most_recent_lastmodified"
  | "earliest"
  | "latest"
  | "sum"
  | "first_non_empty"
  | "valid_e164_first";

type PropertyStrategies = Record<string, MergeStrategy>;

// Defaults per PLAN.md § Merge Rules / Per-field winner strategies
const CONTACT_STRATEGIES: PropertyStrategies = {
  email: "primary_if_not_empty",
  work_email: "primary_if_not_empty",
  firstname: "longest_non_empty",
  lastname: "longest_non_empty",
  phone: "valid_e164_first",
  company: "most_recent_lastmodified",
  jobtitle: "most_recent_lastmodified",
  linkedin_profile: "first_non_empty",
  hs_linkedin_url: "first_non_empty",
  associatedcompanyid: "primary_if_not_empty",
  // createdate is read-only in HubSpot — do NOT PATCH it. HubSpot preserves
  // the older createdate automatically during merge.
};

// Fields we'll never PATCH (HubSpot auto-managed / read-only).
// Discovered 2026-04-17: `createdate` is read-only and caused ~24% of auto-merges
// to fail with 400 VALIDATION_ERROR until it was added here.
const SKIP_PATCH = new Set([
  "hs_object_id",
  "hs_lastmodifieddate",
  "lastmodifieddate",
  "hubspot_owner_id",
  "createdate",
]);

export type ContactRecord = {
  id: string;
  properties: Record<string, string | null>;
};

/**
 * Decide which record should be the primary.
 * Per PLAN.md: most-complete → most-recent-modified → oldest-created.
 */
export function choosePrimary(records: ContactRecord[]): string {
  if (records.length === 0) throw new Error("No records to choose primary from");
  if (records.length === 1) return records[0].id;

  const scored = records.map((r) => ({
    id: r.id,
    completeness: Object.values(r.properties).filter((v) => v && v.length > 0).length,
    lastModified: r.properties.hs_lastmodifieddate
      ? new Date(r.properties.hs_lastmodifieddate).getTime()
      : 0,
    created: r.properties.createdate
      ? new Date(r.properties.createdate).getTime()
      : Number.MAX_SAFE_INTEGER,
  }));

  scored.sort((a, b) => {
    if (a.completeness !== b.completeness) return b.completeness - a.completeness;
    if (a.lastModified !== b.lastModified) return b.lastModified - a.lastModified;
    return a.created - b.created; // older createdate first
  });

  return scored[0].id;
}

/**
 * Compute the winning values for each property across a set of records,
 * given a strategy map. Returns only the properties that differ from what
 * the primary currently has (so we PATCH minimally).
 */
export function computeWinningValues(
  records: ContactRecord[],
  primaryId: string,
  strategies: PropertyStrategies = CONTACT_STRATEGIES
): Record<string, string> {
  const primary = records.find((r) => r.id === primaryId);
  if (!primary) throw new Error(`Primary ${primaryId} not in records`);

  // WHITELIST approach: only consider fields that have an explicit strategy.
  // This prevents accidentally PATCHing HubSpot-managed read-only fields like
  // `createdate`, `hs_additional_emails`, `hs_email_*` metrics, etc.
  // Previously we iterated over all fields and used `primary_if_not_empty` as
  // a default — that caused ~24% of auto-merges to fail on read-only fields.
  const updates: Record<string, string> = {};

  for (const key of Object.keys(strategies)) {
    if (SKIP_PATCH.has(key)) continue;
    const strategy = strategies[key];
    const winner = applyStrategy(records, primary, key, strategy);
    if (winner === null) continue;
    if (winner !== (primary.properties[key] ?? "")) {
      updates[key] = winner;
    }
  }

  return updates;
}

function applyStrategy(
  records: ContactRecord[],
  primary: ContactRecord,
  key: string,
  strategy: MergeStrategy
): string | null {
  const values = records.map((r) => ({
    id: r.id,
    value: r.properties[key] ?? "",
    lastModified: r.properties.hs_lastmodifieddate
      ? new Date(r.properties.hs_lastmodifieddate).getTime()
      : 0,
  }));

  const primaryValue = primary.properties[key] ?? "";

  switch (strategy) {
    case "primary_if_not_empty":
      if (primaryValue) return primaryValue;
      return values.find((v) => v.value)?.value ?? null;

    case "longest_non_empty": {
      const filled = values.filter((v) => v.value);
      if (filled.length === 0) return null;
      filled.sort((a, b) => b.value.length - a.value.length);
      return filled[0].value;
    }

    case "most_recent_lastmodified": {
      const filled = values.filter((v) => v.value);
      if (filled.length === 0) return null;
      filled.sort((a, b) => b.lastModified - a.lastModified);
      return filled[0].value;
    }

    case "earliest": {
      const filled = values.filter((v) => v.value);
      if (filled.length === 0) return null;
      filled.sort((a, b) => {
        const ta = new Date(a.value).getTime();
        const tb = new Date(b.value).getTime();
        return ta - tb;
      });
      return filled[0].value;
    }

    case "latest": {
      const filled = values.filter((v) => v.value);
      if (filled.length === 0) return null;
      filled.sort((a, b) => {
        const ta = new Date(a.value).getTime();
        const tb = new Date(b.value).getTime();
        return tb - ta;
      });
      return filled[0].value;
    }

    case "first_non_empty":
      if (primaryValue) return primaryValue;
      return values.find((v) => v.value)?.value ?? null;

    case "valid_e164_first": {
      const e164 = values.find((v) => v.value && /^\+[1-9]\d{6,14}$/.test(v.value));
      if (e164) return e164.value;
      if (primaryValue) return primaryValue;
      return values.find((v) => v.value)?.value ?? null;
    }

    case "sum": {
      let total = 0;
      for (const v of values) {
        const n = Number.parseFloat(v.value);
        if (!Number.isNaN(n)) total += n;
      }
      return total > 0 ? String(total) : null;
    }

    default:
      return primaryValue || null;
  }
}

// Company merge strategies (narrower field set than contacts)
const COMPANY_STRATEGIES: PropertyStrategies = {
  name: "longest_non_empty",
  domain: "primary_if_not_empty",
  website: "primary_if_not_empty",
  createdate: "earliest",
};

/**
 * Execute a merge in HubSpot: PATCH primary with winning values, then call merge API.
 * Works for contacts or companies via the objectType parameter.
 * Returns { ok: true } on success or { ok: false, error } on failure.
 */
export async function executeContactMerge(
  records: ContactRecord[],
  primaryId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return executeMerge("contact", records, primaryId);
}

export async function executeCompanyMerge(
  records: ContactRecord[],
  primaryId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return executeMerge("company", records, primaryId);
}

async function executeMerge(
  objectType: "contact" | "company",
  records: ContactRecord[],
  primaryId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // 1. Resolve every record ID to its canonical form. HubSpot merges result in
    //    "forward references" where the old ID transparently forwards reads to the
    //    canonical record, but the merge API refuses to accept forward refs as primary.
    //    So we GET each record and use whatever ID HubSpot returns.
    const resolvedIds = new Map<string, string>(); // originalId → canonicalId
    for (const r of records) {
      const canonical = await resolveCanonicalId(objectType, r.id);
      if (!canonical) {
        return { ok: false, error: `Record ${r.id} not found in HubSpot (404)` };
      }
      resolvedIds.set(r.id, canonical);
    }

    // 2. Dedupe canonical IDs. If multiple originals resolve to the same canonical,
    //    those records have already been merged — we just need to merge the remaining
    //    distinct canonicals.
    const canonicalSet = new Set(resolvedIds.values());
    if (canonicalSet.size < 2) {
      // All records already point to the same canonical — nothing to merge,
      // but the group should be marked as already-merged.
      return { ok: true };
    }

    // 3. Pick a primary from the canonical set. Prefer the one the user chose if
    //    it's still canonical; otherwise use whatever the user's chosen primary
    //    now resolves to.
    const canonicalPrimary =
      resolvedIds.get(primaryId) ?? [...canonicalSet][0];
    const canonicalSecondaries = [...canonicalSet].filter(
      (id) => id !== canonicalPrimary
    );
    if (canonicalSecondaries.length === 0) {
      return { ok: true }; // nothing left to merge
    }

    // 4. Build ContactRecord shape for computeWinningValues using original properties
    //    from any record that resolved to each canonical (we don't re-fetch fresh data
    //    here — Phase 2 if we want that).
    const canonicalRecords: ContactRecord[] = [...canonicalSet].map((cid) => {
      const original = records.find((r) => resolvedIds.get(r.id) === cid);
      return { id: cid, properties: original?.properties ?? {} };
    });

    // 5. Compute winning values across the (now canonical) record set
    const strategies = objectType === "company" ? COMPANY_STRATEGIES : CONTACT_STRATEGIES;
    const updates = computeWinningValues(canonicalRecords, canonicalPrimary, strategies);

    // Graceful PATCH: if HubSpot rejects any field as read-only, drop that
    // field and retry. Any OTHER error bubbles up. Worst case we skip the
    // PATCH entirely and rely on the merge API — losing our per-field
    // "combining" for this one group but not losing the merge itself.
    if (Object.keys(updates).length > 0) {
      await patchWithReadOnlyFallback(objectType, canonicalPrimary, updates);
    }

    // 6. Merge each canonical secondary into the canonical primary.
    //    IMPORTANT: HubSpot's merge API may mint a NEW canonical ID when
    //    merging two clean records. After each call, the primary we just
    //    used becomes a forward-reference and subsequent merges must use
    //    the new canonical. Re-resolve between every iteration.
    let currentPrimary = canonicalPrimary;
    for (const secondaryId of canonicalSecondaries) {
      // Re-resolve the primary — it may have been replaced by a new canonical
      const resolvedPrimary = await resolveCanonicalId(objectType, currentPrimary);
      if (!resolvedPrimary) {
        throw new Error(`Primary ${currentPrimary} no longer exists in HubSpot`);
      }
      currentPrimary = resolvedPrimary;

      // Re-resolve the secondary — it may have already been merged into
      // currentPrimary by a previous iteration (if HubSpot collapsed records).
      const resolvedSecondary = await resolveCanonicalId(objectType, secondaryId);
      if (!resolvedSecondary || resolvedSecondary === currentPrimary) {
        continue; // already merged or gone — skip
      }

      if (objectType === "contact") {
        await hubspot.crm.contacts.basicApi.merge({
          primaryObjectId: currentPrimary,
          objectIdToMerge: resolvedSecondary,
        });
      } else {
        await hubspot.crm.companies.basicApi.merge({
          primaryObjectId: currentPrimary,
          objectIdToMerge: resolvedSecondary,
        });
      }
    }

    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Resolve a HubSpot record ID to its canonical form. If the record has been
 * merged into another record, HubSpot returns the canonical `id` in the
 * response body (different from the ID we asked for). Returns null on 404.
 */
async function resolveCanonicalId(
  objectType: "contact" | "company",
  id: string
): Promise<string | null> {
  try {
    const record =
      objectType === "contact"
        ? await hubspot.crm.contacts.basicApi.getById(id, ["hs_object_id"])
        : await hubspot.crm.companies.basicApi.getById(id, ["hs_object_id"]);
    return record.id ?? null;
  } catch (err: unknown) {
    // 404 means the record is gone (fully archived). Return null so caller handles it.
    const status = (err as { code?: number }).code;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * PATCH the primary record with graceful fallback: if HubSpot rejects any
 * fields as read-only, drop those fields and retry. Never gives up entirely
 * on the merge — worst case we skip the PATCH and rely on HubSpot's merge
 * behavior to preserve primary's existing values.
 *
 * Retries up to 5 times (once per iteration of read-only rejections) before
 * giving up silently.
 */
async function patchWithReadOnlyFallback(
  objectType: "contact" | "company",
  id: string,
  updates: Record<string, string>
): Promise<void> {
  let remaining = { ...updates };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (Object.keys(remaining).length === 0) return;
    try {
      if (objectType === "contact") {
        await hubspot.crm.contacts.basicApi.update(id, { properties: remaining });
      } else {
        await hubspot.crm.companies.basicApi.update(id, { properties: remaining });
      }
      return; // success
    } catch (err: unknown) {
      const bodyText = extractErrorBody(err);
      // Try to parse the HubSpot error and find the offending read-only field names
      const readOnlyFields = parseReadOnlyFieldNames(bodyText);
      if (readOnlyFields.length === 0) {
        // Not a read-only error — let it propagate
        throw err;
      }
      // Drop the offending fields and try again
      for (const f of readOnlyFields) delete remaining[f];
    }
  }
  // If we still haven't succeeded after 5 retries, swallow silently. The merge
  // can still proceed — we just lose our per-field winning values for this group.
}

function extractErrorBody(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { body?: unknown; message?: string; response?: { body?: unknown } };
    if (typeof e.body === "string") return e.body;
    if (e.body && typeof e.body === "object") return JSON.stringify(e.body);
    if (e.response?.body && typeof e.response.body === "object") {
      return JSON.stringify(e.response.body);
    }
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

function parseReadOnlyFieldNames(body: string): string[] {
  const names = new Set<string>();
  // HubSpot error format: { "errors": [ { "code": "READ_ONLY_VALUE", "context": { "propertyName": ["fieldname"] } } ] }
  const m1 = body.matchAll(/"code":\s*"READ_ONLY_VALUE"[\s\S]*?"propertyName":\s*\[\s*"([^"]+)"/g);
  for (const match of m1) names.add(match[1]);
  // Alt format in the message: "\"fieldname\" is a read only property"
  const m2 = body.matchAll(/"name":\s*"([^"]+)"[^}]*"error":\s*"READ_ONLY_VALUE"/g);
  for (const match of m2) names.add(match[1]);
  // Also match "already has that value" — HubSpot's weird way of saying a managed field conflict
  if (body.includes("already has that value")) {
    const m3 = body.match(/propertyName=([a-zA-Z_]+)/);
    if (m3) names.add(m3[1]);
  }
  return [...names];
}
