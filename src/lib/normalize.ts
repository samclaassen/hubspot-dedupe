// Normalization helpers — see PLAN.md § Detection Rules / Normalization reference
// Every detection rule normalizes field values before comparing them.

/** LinkedIn URL → canonical slug `linkedin.com/in/{slug}`.
 * Returns null if the input doesn't look like a LinkedIn profile URL.
 */
export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  // Match /in/{slug} anywhere in the string, tolerate protocol/www/trailing chars
  const m = trimmed.match(/linkedin\.com\/in\/([^\/?#\s]+)/);
  if (!m) return null;
  const slug = m[1].replace(/\/+$/, ""); // strip trailing slashes
  if (!slug) return null;
  return `linkedin.com/in/${slug}`;
}

/** Email normalizer. Applies Gmail dot-stripping and `+alias` removal.
 * Returns lowercase canonical form or null if input isn't a valid-looking email.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;

  const atIdx = trimmed.lastIndexOf("@");
  let local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (!local || !domain) return null;

  // Strip + alias for all domains
  const plusIdx = local.indexOf("+");
  if (plusIdx >= 0) local = local.slice(0, plusIdx);

  // Gmail-only: strip dots in local part
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }

  if (!local) return null;
  return `${local}@${domain}`;
}

/** Collect all normalized emails from a contact's email fields.
 * Expanded 2026-04-15: pools ALL known email fields for maximum coverage.
 * Previously restricted to `email` + `work_email`; we discovered real
 * duplicates were being missed because their email was in enrichment fields.
 */
export function collectContactEmails(properties: Record<string, string | null>): string[] {
  const fields = [
    "email",
    "work_email",
    "exactbuyer_current_work_email",
    "hs_additional_emails",
  ];
  const set = new Set<string>();
  for (const f of fields) {
    // hs_additional_emails can be a semicolon-separated list
    const raw = properties[f];
    if (!raw) continue;
    for (const part of raw.split(/[;,]/)) {
      const n = normalizeEmail(part);
      if (n) set.add(n);
    }
  }
  return [...set];
}

/** Collect LinkedIn URLs from a contact.
 * Expanded 2026-04-15: pools `linkedin_profile`, `hs_linkedin_url`, and
 * `pb_linkedin_profile_url`. The same LinkedIn URL can live in any of these
 * fields on different records (verified on real HubSpot portals), so we must
 * check all three to catch all duplicates.
 */
export function collectContactLinkedIn(properties: Record<string, string | null>): string[] {
  const fields = ["linkedin_profile", "hs_linkedin_url", "pb_linkedin_profile_url"];
  const set = new Set<string>();
  for (const f of fields) {
    const n = normalizeLinkedInUrl(properties[f]);
    if (n) set.add(n);
  }
  return [...set];
}

/** Normalize a person's name: lowercase, strip titles, collapse whitespace. */
const TITLE_RE = /\b(mr|mrs|ms|miss|mx|dr|prof|sir|madam|madame)\.?\b/gi;
export function normalizePersonName(
  first: string | null | undefined,
  last: string | null | undefined
): string {
  const combined = `${first ?? ""} ${last ?? ""}`
    .toLowerCase()
    .replace(TITLE_RE, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return combined;
}

/** Normalize a company name: strip legal suffixes, lowercase. */
const LEGAL_SUFFIX_RE =
  /\b(inc|incorporated|llc|l\.l\.c\.|ltd|limited|co|company|corp|corporation|gmbh|sa|s\.a\.|sas|s\.a\.s\.|pty|ab|plc|bv|b\.v\.|srl|spa|oyj)\.?\b/gi;
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical pair key: sorted tuple of two IDs.
 * Used for deduping matched pairs across multiple blocks.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
