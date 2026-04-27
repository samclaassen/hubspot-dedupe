// Tiered matching engine — see PLAN.md § Detection Rules.
// Consumes a list of contacts with normalized fields and produces duplicate groups.
//
// Tiers (high → low priority, first match wins):
//   Tier 1.1 — LinkedIn URL (confidence 1.0, auto-merge eligible)
//   Tier 1.2 — Email        (confidence 1.0, auto-merge eligible)
//   Tier 2.1 — Name + Company exact OR fuzzy (confidence ~0.95, review required)
//   Tier 3   — Fuzzy weighted score (confidence 0.85+, review required)

import {
  token_sort_ratio,
  token_set_ratio,
  partial_ratio,
} from "fuzzball";
import {
  collectContactEmails,
  collectContactLinkedIn,
  normalizePersonName,
  normalizeCompanyName,
  pairKey,
} from "@/lib/normalize";

export type Contact = {
  id: string;
  properties: Record<string, string | null>;
};

export type MatchTier =
  | "tier1_linkedin"
  | "tier1_email"
  | "tier2_name_company"
  | "tier3_fuzzy";

export type DetectedGroup = {
  tier: MatchTier;
  score: number;
  reasons: Record<string, string>;
  memberIds: string[];
};

const FUZZY_NAME_THRESHOLD = 92;
const FUZZY_COMPANY_THRESHOLD = 88;
const TIER3_SCORE_THRESHOLD = 0.85;
const TIER3_AUTO_MERGE_THRESHOLD = 0.99;

/**
 * Run the full tiered detection pipeline on a set of contacts.
 * Returns duplicate groups deduplicated across tiers (highest tier wins per pair).
 */
export function detectDuplicates(contacts: Contact[]): DetectedGroup[] {
  // Index for fast lookups
  const byId = new Map<string, Contact>();
  for (const c of contacts) byId.set(c.id, c);

  // Groups produced, keyed by tier for telemetry
  const groups: DetectedGroup[] = [];

  // Pairs already matched at a higher tier — skipped in subsequent tiers
  const seenPairs = new Set<string>();

  // -------- Tier 1.1: LinkedIn URL --------
  const linkedinBlocks = buildBlocks(contacts, (c) =>
    collectContactLinkedIn(c.properties)
  );
  for (const [slug, ids] of linkedinBlocks) {
    if (ids.length < 2) continue;
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length < 2) continue;
    markPairs(uniqueIds, seenPairs);
    groups.push({
      tier: "tier1_linkedin",
      score: 1.0,
      reasons: { linkedin_profile: slug },
      memberIds: uniqueIds,
    });
  }

  // -------- Tier 1.2: Email --------
  const emailBlocks = buildBlocks(contacts, (c) =>
    collectContactEmails(c.properties)
  );
  for (const [email, ids] of emailBlocks) {
    if (ids.length < 2) continue;
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length < 2) continue;
    // Only emit if any new pair in this block isn't already covered
    if (!anyNewPair(uniqueIds, seenPairs)) continue;
    markPairs(uniqueIds, seenPairs);
    groups.push({
      tier: "tier1_email",
      score: 1.0,
      reasons: { email },
      memberIds: uniqueIds,
    });
  }

  // -------- Tier 2.1: Name + Company --------
  // Block by (normalizedName, companyKey). A company key is either the
  // associatedcompanyid (exact) or a normalized company name fingerprint.
  // For fuzzy name/company matching within a bucket we check pairs individually.
  //
  // Approach:
  //   1. Block on associatedcompanyid: all contacts in the same company.
  //      Within each block, pair up contacts with matching names.
  //   2. Block on first 4 chars of normalized company (fallback for records
  //      without associatedcompanyid). Within each block, check both name AND
  //      company fuzzy match.
  for (const block of companyIdBlocks(contacts)) {
    // Block size limit — skip huge companies (would be O(n²) within them)
    if (block.length > 200) continue;
    emitTier2Pairs(block, byId, seenPairs, groups);
  }
  for (const block of companyNamePrefixBlocks(contacts)) {
    if (block.length > 200) continue;
    emitTier2Pairs(block, byId, seenPairs, groups);
  }

  // -------- Tier 3: Fuzzy scoring (fallback) --------
  // Only run on contacts not already caught by Tiers 1 or 2.
  // Block by soundex(lastname) + firstname[0] to keep block sizes small.
  const notYetMatched = new Set<string>();
  for (const c of contacts) notYetMatched.add(c.id);
  for (const g of groups) {
    for (const id of g.memberIds) notYetMatched.delete(id);
  }

  const leftovers = contacts.filter((c) => notYetMatched.has(c.id));
  for (const block of nameBlocks(leftovers)) {
    if (block.length > 200) continue;
    emitTier3Pairs(block, byId, seenPairs, groups);
  }

  // -------- Post-processing: union-find to unify overlapping groups --------
  // When the same records are caught by multiple tiers (e.g., Lindsay O'Brien
  // matches via LinkedIn AND via Name+Company), those sub-groups often overlap
  // on member IDs. We union-find all groups that share ≥1 member so the user
  // sees ONE connected component per real person, not 4 separate pair groups.
  return unifyOverlappingGroups(groups);
}

// ----- Union-find group unification -----

const TIER_PRIORITY: Record<MatchTier, number> = {
  tier1_linkedin: 4,
  tier1_email: 3,
  tier2_name_company: 2,
  tier3_fuzzy: 1,
};

function unifyOverlappingGroups(groups: DetectedGroup[]): DetectedGroup[] {
  if (groups.length === 0) return groups;

  const parent: number[] = groups.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path compression
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const pi = find(i);
    const pj = find(j);
    if (pi !== pj) parent[pi] = pj;
  };

  // For each member ID, track the first group index we saw it in.
  // When we encounter it in another group, union those two group indices.
  const memberToGroup = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    for (const id of groups[i].memberIds) {
      const seenIn = memberToGroup.get(id);
      if (seenIn !== undefined) {
        union(i, seenIn);
      } else {
        memberToGroup.set(id, i);
      }
    }
  }

  // Build unified groups: for each root index, collect all groups that map to it
  const byRoot = new Map<number, DetectedGroup[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    const list = byRoot.get(root) ?? [];
    list.push(groups[i]);
    byRoot.set(root, list);
  }

  const unified: DetectedGroup[] = [];
  for (const subGroups of byRoot.values()) {
    if (subGroups.length === 1) {
      unified.push(subGroups[0]);
      continue;
    }
    // Merge multiple sub-groups into one
    const memberIds = new Set<string>();
    let bestTier = subGroups[0].tier;
    let bestScore = subGroups[0].score;
    const mergedReasons: Record<string, string> = {};
    for (const g of subGroups) {
      for (const id of g.memberIds) memberIds.add(id);
      if (TIER_PRIORITY[g.tier] > TIER_PRIORITY[bestTier]) {
        bestTier = g.tier;
      }
      if (g.score > bestScore) bestScore = g.score;
      // Merge reasons: first-writer-wins per key, with a tier prefix if multiple
      for (const [k, v] of Object.entries(g.reasons)) {
        if (!mergedReasons[k]) mergedReasons[k] = v;
      }
    }
    unified.push({
      tier: bestTier,
      score: bestScore,
      reasons: mergedReasons,
      memberIds: [...memberIds],
    });
  }

  return unified;
}

// ----- Block builders -----

/** Build a map from a key to a list of contact IDs that produce that key. */
function buildBlocks(
  contacts: Contact[],
  keyExtractor: (c: Contact) => string[]
): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const c of contacts) {
    const keys = keyExtractor(c);
    for (const k of keys) {
      const list = blocks.get(k) ?? [];
      list.push(c.id);
      blocks.set(k, list);
    }
  }
  return blocks;
}

/** Group contacts by associatedcompanyid. */
function companyIdBlocks(contacts: Contact[]): Contact[][] {
  const byCompany = new Map<string, Contact[]>();
  for (const c of contacts) {
    const cid = c.properties.associatedcompanyid;
    if (!cid) continue;
    const list = byCompany.get(cid) ?? [];
    list.push(c);
    byCompany.set(cid, list);
  }
  return [...byCompany.values()].filter((b) => b.length >= 2);
}

/** Group contacts by first 4 chars of normalized company name. */
function companyNamePrefixBlocks(contacts: Contact[]): Contact[][] {
  const byPrefix = new Map<string, Contact[]>();
  for (const c of contacts) {
    const normalized = normalizeCompanyName(c.properties.company);
    if (!normalized || normalized.length < 4) continue;
    const prefix = normalized.slice(0, 4);
    const list = byPrefix.get(prefix) ?? [];
    list.push(c);
    byPrefix.set(prefix, list);
  }
  return [...byPrefix.values()].filter((b) => b.length >= 2);
}

/** Group contacts by soundex(lastname) + firstname[0] for Tier 3 blocking. */
function nameBlocks(contacts: Contact[]): Contact[][] {
  const byKey = new Map<string, Contact[]>();
  for (const c of contacts) {
    const first = (c.properties.firstname ?? "").trim().toLowerCase();
    const last = (c.properties.lastname ?? "").trim().toLowerCase();
    if (!last) continue;
    const key = `${soundex(last)}_${first[0] ?? ""}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  return [...byKey.values()].filter((b) => b.length >= 2);
}

// ----- Conflicting-identity safety check -----

/**
 * Returns true if two records have CONFLICTING identity signals — e.g.,
 * different non-empty emails or different non-empty LinkedIn URLs. When
 * this fires, Tier 2/3 should skip the pair even if name + company match,
 * because the records are demonstrably different humans.
 *
 * Real-world motivation: A HubSpot portal had 15 records with firstname="John"
 * and lastname="Solaro" (a corrupted automation template) that were each a
 * DIFFERENT real person with distinct emails and distinct LinkedIn profiles.
 * Without this check, union-find would collapse them into a single group
 * and Auto-merge All would destroy 14 real contacts.
 *
 * This check is NOT applied to Tier 1 (same LinkedIn or same email is a
 * definitive signal that overrides surface-level field conflicts).
 */
function hasConflictingIdentities(a: Contact, b: Contact): boolean {
  const emailsA = collectContactEmails(a.properties);
  const emailsB = collectContactEmails(b.properties);
  if (emailsA.length > 0 && emailsB.length > 0) {
    const overlap = emailsA.some((e) => emailsB.includes(e));
    if (!overlap) return true;
  }
  const liA = collectContactLinkedIn(a.properties);
  const liB = collectContactLinkedIn(b.properties);
  if (liA.length > 0 && liB.length > 0) {
    const overlap = liA.some((l) => liB.includes(l));
    if (!overlap) return true;
  }
  return false;
}

// ----- Tier 2 pair emission -----

function emitTier2Pairs(
  block: Contact[],
  byId: Map<string, Contact>,
  seenPairs: Set<string>,
  groups: DetectedGroup[]
): void {
  // Within a company block, pair up contacts whose names match (exact or fuzzy).
  for (let i = 0; i < block.length; i++) {
    for (let j = i + 1; j < block.length; j++) {
      const a = block[i];
      const b = block[j];
      const pk = pairKey(a.id, b.id);
      if (seenPairs.has(pk)) continue;

      // SAFETY: Skip if records have conflicting identities (different
      // non-empty emails or different non-empty LinkedIn URLs). Protects
      // against corrupted-name cases like the corrupted-name automation bug.
      if (hasConflictingIdentities(a, b)) continue;

      const nameA = normalizePersonName(a.properties.firstname, a.properties.lastname);
      const nameB = normalizePersonName(b.properties.firstname, b.properties.lastname);
      if (!nameA || !nameB) continue;

      // Lastname-only match: when at least one record has no firstname but
      // both share the same non-empty lastname (and same company), treat as a
      // match. This catches records with missing firstname fields that would
      // otherwise be invisible to Tier 2. See PLAN.md § Detection Rules.
      const firstA = (a.properties.firstname ?? "").trim();
      const firstB = (b.properties.firstname ?? "").trim();
      const lastA = (a.properties.lastname ?? "").trim().toLowerCase();
      const lastB = (b.properties.lastname ?? "").trim().toLowerCase();
      const firstnameUnknownOnEitherSide = !firstA || !firstB;
      const lastnameMatch = !!lastA && !!lastB && lastA === lastB;

      // Name must match exactly, fuzzily at ≥92, OR lastname-only when
      // firstname is missing on either side.
      const exactOrFuzzyMatch =
        nameA === nameB ||
        token_sort_ratio(nameA, nameB) >= FUZZY_NAME_THRESHOLD;
      const lastnameOnlyMatch = firstnameUnknownOnEitherSide && lastnameMatch;
      const nameMatch = exactOrFuzzyMatch || lastnameOnlyMatch;
      if (!nameMatch) continue;

      // Company: already in same block — either same associatedcompanyid,
      // or same normalized company prefix. For prefix blocks we still need to
      // verify the full company name fuzzy-matches.
      const companyA = normalizeCompanyName(a.properties.company);
      const companyB = normalizeCompanyName(b.properties.company);
      const sameCompanyId =
        a.properties.associatedcompanyid &&
        a.properties.associatedcompanyid === b.properties.associatedcompanyid;
      const fuzzyCompany =
        companyA &&
        companyB &&
        token_set_ratio(companyA, companyB) >= FUZZY_COMPANY_THRESHOLD;
      if (!sameCompanyId && !fuzzyCompany) continue;

      seenPairs.add(pk);
      // Tag the name reason so the review UI shows why this pair was flagged.
      // Lastname-only matches are slightly lower confidence so we note them.
      let nameReason: string;
      if (nameA === nameB) nameReason = `exact:${nameA}`;
      else if (exactOrFuzzyMatch) nameReason = `fuzzy:${nameA}|${nameB}`;
      else nameReason = `lastname_only:${lastA}`;
      // Lastname-only matches auto-merge at 0.99 per user decision: if one
      // side has a firstname, the merge rules (longest_non_empty on firstname)
      // will backfill the missing side; if neither has a firstname, there's
      // nothing to lose. See MERGE_RULES.md.
      groups.push({
        tier: "tier2_name_company",
        score: 0.99,
        reasons: {
          name: nameReason,
          company: sameCompanyId
            ? `same_id:${a.properties.associatedcompanyid}`
            : `fuzzy:${companyA}|${companyB}`,
        },
        memberIds: [a.id, b.id],
      });
    }
  }
  // byId param is unused here but keeps symmetry with emitTier3Pairs
  void byId;
}

// ----- Tier 3 pair emission -----

function emitTier3Pairs(
  block: Contact[],
  byId: Map<string, Contact>,
  seenPairs: Set<string>,
  groups: DetectedGroup[]
): void {
  for (let i = 0; i < block.length; i++) {
    for (let j = i + 1; j < block.length; j++) {
      const a = block[i];
      const b = block[j];
      const pk = pairKey(a.id, b.id);
      if (seenPairs.has(pk)) continue;

      // SAFETY: skip pairs with conflicting identities (different non-empty
      // emails or different non-empty LinkedIn URLs). Same protection as Tier 2.
      if (hasConflictingIdentities(a, b)) continue;

      const score = computeFuzzyScore(a, b);
      if (score < TIER3_SCORE_THRESHOLD) continue;

      seenPairs.add(pk);
      groups.push({
        tier: "tier3_fuzzy",
        score,
        reasons: {
          fuzzy_score: score.toFixed(3),
          name: `${a.properties.firstname ?? ""} ${a.properties.lastname ?? ""}|${b.properties.firstname ?? ""} ${b.properties.lastname ?? ""}`,
        },
        memberIds: [a.id, b.id],
      });
    }
  }
  void byId;
}

/**
 * Compute a weighted fuzzy score between two contacts on the fields listed
 * in PLAN.md § Tier 3. Weights only count fields where BOTH records have data.
 */
function computeFuzzyScore(a: Contact, b: Contact): number {
  const nameA = normalizePersonName(a.properties.firstname, a.properties.lastname);
  const nameB = normalizePersonName(b.properties.firstname, b.properties.lastname);
  const companyA = normalizeCompanyName(a.properties.company);
  const companyB = normalizeCompanyName(b.properties.company);
  const phoneA = (a.properties.phone ?? "").replace(/[^\d+]/g, "");
  const phoneB = (b.properties.phone ?? "").replace(/[^\d+]/g, "");
  const jobA = (a.properties.jobtitle ?? "").toLowerCase().trim();
  const jobB = (b.properties.jobtitle ?? "").toLowerCase().trim();

  let totalWeight = 0;
  let weightedSum = 0;

  if (nameA && nameB) {
    totalWeight += 0.5;
    weightedSum += 0.5 * (token_sort_ratio(nameA, nameB) / 100);
  }
  if (companyA && companyB) {
    totalWeight += 0.3;
    weightedSum += 0.3 * (token_set_ratio(companyA, companyB) / 100);
  }
  if (phoneA && phoneB) {
    totalWeight += 0.1;
    weightedSum += 0.1 * (phoneA === phoneB ? 1 : 0);
  }
  if (jobA && jobB) {
    totalWeight += 0.1;
    weightedSum += 0.1 * (partial_ratio(jobA, jobB) / 100);
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

// ----- helpers -----

function markPairs(ids: string[], seenPairs: Set<string>): void {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      seenPairs.add(pairKey(ids[i], ids[j]));
    }
  }
}

function anyNewPair(ids: string[], seenPairs: Set<string>): boolean {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (!seenPairs.has(pairKey(ids[i], ids[j]))) return true;
    }
  }
  return false;
}

// ----- Companies detection -----

/**
 * Detect duplicate companies.
 * Tier 1: same normalized domain
 * Tier 2: fuzzy company name match ≥88 within same domain-prefix block
 */
export function detectCompanyDuplicates(companies: Contact[]): DetectedGroup[] {
  const groups: DetectedGroup[] = [];
  const seenPairs = new Set<string>();

  // Tier 1 — same normalized domain
  const domainBlocks = new Map<string, string[]>();
  for (const c of companies) {
    const domain = normalizeDomain(c.properties.domain) ?? normalizeDomain(c.properties.website);
    if (!domain) continue;
    const list = domainBlocks.get(domain) ?? [];
    list.push(c.id);
    domainBlocks.set(domain, list);
  }
  for (const [domain, ids] of domainBlocks) {
    if (ids.length < 2) continue;
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length < 2) continue;
    markPairs(uniqueIds, seenPairs);
    groups.push({
      tier: "tier1_email", // reuse tier label for "domain match" (same confidence)
      score: 1.0,
      reasons: { domain },
      memberIds: uniqueIds,
    });
  }

  // Tier 2 — fuzzy name within prefix blocks
  const byPrefix = new Map<string, Contact[]>();
  for (const c of companies) {
    const normalized = normalizeCompanyName(c.properties.name);
    if (!normalized || normalized.length < 4) continue;
    const prefix = normalized.slice(0, 4);
    const list = byPrefix.get(prefix) ?? [];
    list.push(c);
    byPrefix.set(prefix, list);
  }
  for (const block of byPrefix.values()) {
    if (block.length < 2 || block.length > 200) continue;
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        const a = block[i];
        const b = block[j];
        const pk = pairKey(a.id, b.id);
        if (seenPairs.has(pk)) continue;
        // SAFETY: skip pairs whose populated domains differ — they're
        // distinct companies that happen to share a name prefix (e.g.
        // "Octane" at octane.co vs "Octane Lending" at octanelending.com).
        // Mirrors hasConflictingIdentities() for contacts.
        if (hasConflictingCompanyDomains(a, b)) continue;
        const na = normalizeCompanyName(a.properties.name);
        const nb = normalizeCompanyName(b.properties.name);
        if (!na || !nb) continue;
        const ratio = token_set_ratio(na, nb);
        if (ratio < FUZZY_COMPANY_THRESHOLD) continue;
        seenPairs.add(pk);
        groups.push({
          tier: "tier2_name_company",
          score: ratio / 100,
          reasons: { name_fuzzy: `${na}|${nb}`, score: ratio.toString() },
          memberIds: [a.id, b.id],
        });
      }
    }
  }

  return groups;
}

/**
 * Returns true if two company records have populated, differing domains.
 * When both records have a domain (or website) and they don't match, they
 * are almost certainly distinct companies — skip the fuzzy-name pair.
 * Pairs where one side has no domain (stub records) are allowed through;
 * the merge UI still lets the user review them.
 */
function hasConflictingCompanyDomains(a: Contact, b: Contact): boolean {
  const dA =
    normalizeDomain(a.properties.domain) ??
    normalizeDomain(a.properties.website);
  const dB =
    normalizeDomain(b.properties.domain) ??
    normalizeDomain(b.properties.website);
  return !!(dA && dB && dA !== dB);
}

/** Normalize a domain: lowercase, strip protocol/www/path. */
function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  // Strip path and query
  const slashIdx = s.indexOf("/");
  if (slashIdx >= 0) s = s.slice(0, slashIdx);
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) s = s.slice(0, qIdx);
  s = s.replace(/\/+$/, "");
  if (!s || !s.includes(".")) return null;
  return s;
}

/** Classic Soundex — 4-char phonetic key for English names. */
function soundex(name: string): string {
  if (!name) return "";
  const s = name.toUpperCase();
  const first = s[0];
  const map: Record<string, string> = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3",
    L: "4",
    M: "5", N: "5",
    R: "6",
  };
  const tail = s
    .slice(1)
    .split("")
    .map((c) => map[c] ?? "")
    .filter((v, i, arr) => i === 0 || v !== arr[i - 1]) // collapse repeats
    .join("")
    .padEnd(3, "0")
    .slice(0, 3);
  return first + tail;
}

export const _test = {
  TIER3_SCORE_THRESHOLD,
  TIER3_AUTO_MERGE_THRESHOLD,
  soundex,
  computeFuzzyScore,
};
