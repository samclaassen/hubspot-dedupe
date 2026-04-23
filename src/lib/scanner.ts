// Scanner — orchestrates paginating HubSpot, detection, and persistence.
// See PLAN.md § Detection Rules and src/lib/match.ts for the detection engine.

import { db } from "@/lib/db";
import {
  paginateContacts,
  paginateCompanies,
  getContactsTotal,
  getCompaniesTotal,
  batchResolveCanonicalContactIds,
} from "@/lib/hubspot";
import {
  detectDuplicates,
  detectCompanyDuplicates,
  type Contact,
  type DetectedGroup,
} from "@/lib/match";
import { pairKey } from "@/lib/normalize";

// Properties we need from HubSpot for all 3 tiers of contact detection.
const CONTACT_PROPERTIES = [
  "hs_object_id",
  // Tier 1.1 — LinkedIn URL (all 3 fields pooled per collectContactLinkedIn)
  "linkedin_profile",
  "hs_linkedin_url",
  "pb_linkedin_profile_url",
  // Tier 1.2 — Email (all 4 fields pooled per collectContactEmails)
  "email",
  "work_email",
  "exactbuyer_current_work_email",
  "hs_additional_emails",
  // Tier 2.1 / Tier 3 — Name, Company, Phone, Jobtitle
  "firstname",
  "lastname",
  "company",
  "associatedcompanyid",
  "phone",
  "jobtitle",
  // Metadata for primary selection + merge rules
  "createdate",
  "hs_lastmodifieddate",
];

/** Run a full contact scan in the background. Writes progress to ScanRun row. */
export async function runContactScan(scanRunId: string): Promise<void> {
  try {
    await db.scanRun.update({
      where: { id: scanRunId },
      data: { status: "running", stage: "counting", startedAt: new Date() },
    });

    const total = await getContactsTotal();
    await db.scanRun.update({
      where: { id: scanRunId },
      data: { totalRecords: total, stage: "paginating" },
    });

    // Collect all contacts into memory. ~50k contacts * ~12 properties is under
    // 20 MB, fine for SQLite + Node. If we later scan portals > 500k we'll
    // need to spill to disk, but for v1 this keeps the code simple.
    const contacts: Contact[] = [];
    let scanned = 0;
    for await (const page of paginateContacts(CONTACT_PROPERTIES)) {
      for (const row of page) {
        contacts.push({ id: row.id, properties: row.properties });
      }
      scanned += page.length;

      // Progress update every page
      await db.scanRun.update({
        where: { id: scanRunId },
        data: { recordsScanned: scanned },
      });
    }

    // Detection
    await db.scanRun.update({
      where: { id: scanRunId },
      data: { stage: "matching" },
    });

    const rawDetected = detectDuplicates(contacts);

    // Filter detected groups:
    //  1. Drop pairs that are in the SuppressedPair table (Skip decisions
    //     from previous scans). If all pairs in a group are suppressed, drop
    //     the whole group.
    //  2. Drop groups where any member has already been merged into another
    //     record (forward reference). These would create phantom groups that
    //     are already stale.
    const detected = await filterDetectedGroups(rawDetected, "contact");

    // Persist
    await db.scanRun.update({
      where: { id: scanRunId },
      data: { stage: "persisting", groupsFound: detected.length },
    });

    const contactsById = new Map<string, Contact>();
    for (const c of contacts) contactsById.set(c.id, c);

    // Create groups in batches of 50 to keep transaction sizes reasonable
    const BATCH = 50;
    for (let i = 0; i < detected.length; i += BATCH) {
      const batch = detected.slice(i, i + BATCH);
      await db.$transaction(
        batch.map((g) =>
          db.duplicateGroup.create({
            data: {
              scanRunId,
              objectType: "contact",
              matchTier: g.tier,
              matchScore: g.score,
              matchReasons: JSON.stringify(g.reasons),
              status: "pending",
              members: {
                create: g.memberIds.map((id) => ({
                  hubspotId: id,
                  propertiesSnapshot: JSON.stringify(
                    contactsById.get(id)?.properties ?? {}
                  ),
                })),
              },
            },
          })
        )
      );
    }

    await db.scanRun.update({
      where: { id: scanRunId },
      data: {
        status: "complete",
        stage: null,
        completedAt: new Date(),
        groupsFound: detected.length,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Scan ${scanRunId} failed:`, err);
    await db.scanRun.update({
      where: { id: scanRunId },
      data: {
        status: "failed",
        stage: null,
        completedAt: new Date(),
        error: message,
      },
    });
  }
}

// ----- Companies scanner -----

const COMPANY_PROPERTIES = [
  "hs_object_id",
  "name",
  "domain",
  "website",
  "createdate",
  "hs_lastmodifieddate",
];

/** Run a full company scan in the background. Writes progress to ScanRun row. */
export async function runCompanyScan(scanRunId: string): Promise<void> {
  try {
    await db.scanRun.update({
      where: { id: scanRunId },
      data: { status: "running", stage: "counting", startedAt: new Date() },
    });

    const total = await getCompaniesTotal();
    await db.scanRun.update({
      where: { id: scanRunId },
      data: { totalRecords: total, stage: "paginating" },
    });

    const companies: Contact[] = [];
    let scanned = 0;
    for await (const page of paginateCompanies(COMPANY_PROPERTIES)) {
      for (const row of page) {
        companies.push({ id: row.id, properties: row.properties });
      }
      scanned += page.length;
      await db.scanRun.update({
        where: { id: scanRunId },
        data: { recordsScanned: scanned },
      });
    }

    await db.scanRun.update({
      where: { id: scanRunId },
      data: { stage: "matching" },
    });

    const rawDetected = detectCompanyDuplicates(companies);
    const detected = await filterDetectedGroups(rawDetected, "company");

    await db.scanRun.update({
      where: { id: scanRunId },
      data: { stage: "persisting", groupsFound: detected.length },
    });

    const companiesById = new Map<string, Contact>();
    for (const c of companies) companiesById.set(c.id, c);

    const BATCH = 50;
    for (let i = 0; i < detected.length; i += BATCH) {
      const batch = detected.slice(i, i + BATCH);
      await db.$transaction(
        batch.map((g) =>
          db.duplicateGroup.create({
            data: {
              scanRunId,
              objectType: "company",
              matchTier: g.tier,
              matchScore: g.score,
              matchReasons: JSON.stringify(g.reasons),
              status: "pending",
              members: {
                create: g.memberIds.map((id) => ({
                  hubspotId: id,
                  propertiesSnapshot: JSON.stringify(
                    companiesById.get(id)?.properties ?? {}
                  ),
                })),
              },
            },
          })
        )
      );
    }

    await db.scanRun.update({
      where: { id: scanRunId },
      data: {
        status: "complete",
        stage: null,
        completedAt: new Date(),
        groupsFound: detected.length,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Company scan ${scanRunId} failed:`, err);
    await db.scanRun.update({
      where: { id: scanRunId },
      data: {
        status: "failed",
        stage: null,
        completedAt: new Date(),
        error: message,
      },
    });
  }
}

// ----- Filtering: SuppressedPair + forward-reference removal -----

/**
 * Filter detected groups before persisting them:
 *
 * 1. Drop pairs the user has already Skipped (SuppressedPair table). If all
 *    pairs in a group are suppressed, drop the entire group.
 * 2. Drop groups that contain any forward-referenced record (record has
 *    already been merged into another HubSpot record). These would create
 *    noise by re-surfacing records that no longer exist as canonicals.
 *
 * For contacts, uses the batch canonical resolution API. For companies,
 * we skip forward-ref filtering (the volume is typically lower and
 * the company merge API is less prone to this issue).
 */
async function filterDetectedGroups(
  groups: DetectedGroup[],
  objectType: "contact" | "company"
): Promise<DetectedGroup[]> {
  if (groups.length === 0) return groups;

  // --- Step 1: load suppressed pairs into a Set for fast lookup ---
  const suppressed = await db.suppressedPair.findMany({
    where: { objectType },
    select: { idA: true, idB: true },
  });
  const suppressedSet = new Set(
    suppressed.map((p) => `${p.idA}:${p.idB}`) // idA already < idB per skipGroup
  );

  // --- Step 2: for contacts, resolve canonicals so we can drop forward refs ---
  let canonicalMap = new Map<string, string>();
  if (objectType === "contact") {
    const allIds = new Set<string>();
    for (const g of groups) for (const id of g.memberIds) allIds.add(id);
    canonicalMap = await batchResolveCanonicalContactIds([...allIds]);
  }

  // --- Step 3: filter groups ---
  const out: DetectedGroup[] = [];
  for (const g of groups) {
    // Forward-ref filter (contacts only): if ANY member's canonical differs
    // from its own ID, the member is a ghost — drop the whole group. The
    // user will re-see the real duplicate in the next scan (if one exists)
    // under the actual canonical ID.
    if (objectType === "contact") {
      const hasForwardRef = g.memberIds.some((id) => {
        const canonical = canonicalMap.get(id);
        // If canonical is missing (404), keep the group — the caller should
        // surface the error at merge time. If canonical differs from id, drop.
        return canonical !== undefined && canonical !== id;
      });
      if (hasForwardRef) continue;
    }

    // Suppressed-pair filter: keep only members that share at least one
    // non-suppressed pair with another member. If every pair in the group
    // is suppressed, drop the group entirely.
    let anyAlivePair = false;
    for (let i = 0; i < g.memberIds.length && !anyAlivePair; i++) {
      for (let j = i + 1; j < g.memberIds.length; j++) {
        if (!suppressedSet.has(pairKey(g.memberIds[i], g.memberIds[j]))) {
          anyAlivePair = true;
          break;
        }
      }
    }
    if (!anyAlivePair) continue;

    out.push(g);
  }

  return out;
}
