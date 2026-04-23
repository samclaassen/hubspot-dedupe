// HubSpot client wrapper — handles pagination, rate limiting, and retries.
// Single-portal via Private App token (see PLAN.md).

import { Client } from "@hubspot/api-client";
import pLimit from "p-limit";

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (!token) {
  throw new Error("HUBSPOT_ACCESS_TOKEN is not set — see PLAN.md § HubSpot API specifics");
}

// HubSpot allows 100 req/10s on standard portals. Cap at 8 concurrent requests
// with a light stagger; SDK will also surface 429s which we catch + retry.
const limit = pLimit(8);

export const hubspot = new Client({ accessToken: token });

// Pagination helper — streams all records from the list endpoint in 100-record pages.
// CRITICAL: We use basicApi.getPage (not searchApi.doSearch) because HubSpot's
// Search API has a hard 10,000 result cap. basicApi.getPage has no such limit.
// See PLAN.md § Risks / HubSpot API specifics.
export async function* paginateContacts(properties: string[]): AsyncGenerator<
  Array<{ id: string; properties: Record<string, string | null> }>
> {
  let after: string | undefined = undefined;
  while (true) {
    const page: Awaited<
      ReturnType<typeof hubspot.crm.contacts.basicApi.getPage>
    > = await limit(() =>
      withRetry(() =>
        hubspot.crm.contacts.basicApi.getPage(
          100,           // limit
          after,         // after
          properties,    // properties
          undefined,     // propertiesWithHistory
          undefined,     // associations
          false          // archived
        )
      )
    );

    const rows = page.results.map((r) => ({
      id: r.id,
      properties: (r.properties ?? {}) as Record<string, string | null>,
    }));
    yield rows;

    after = page.paging?.next?.after;
    if (!after) break;
  }
}

export async function* paginateCompanies(properties: string[]): AsyncGenerator<
  Array<{ id: string; properties: Record<string, string | null> }>
> {
  let after: string | undefined = undefined;
  while (true) {
    const page: Awaited<
      ReturnType<typeof hubspot.crm.companies.basicApi.getPage>
    > = await limit(() =>
      withRetry(() =>
        hubspot.crm.companies.basicApi.getPage(
          100,
          after,
          properties,
          undefined,
          undefined,
          false
        )
      )
    );

    const rows = page.results.map((r) => ({
      id: r.id,
      properties: (r.properties ?? {}) as Record<string, string | null>,
    }));
    yield rows;

    after = page.paging?.next?.after;
    if (!after) break;
  }
}

/**
 * Batch-resolve IDs to their canonical form. Returns a Map from requested ID
 * to canonical ID. If an ID resolves to a different ID, it's a forward-ref
 * (record was merged). If an ID is missing from the map, the record doesn't
 * exist (404 / archived).
 *
 * Uses HubSpot's batch read API (up to 100 per call) so this is efficient
 * even for thousands of IDs. Called by the scanner to filter out
 * forward-referenced records before running detection.
 */
export async function batchResolveCanonicalContactIds(
  ids: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const resp = await withRetry(() =>
        hubspot.crm.contacts.batchApi.read({
          inputs: chunk.map((id) => ({ id })),
          properties: ["hs_object_id"],
          propertiesWithHistory: [],
          idProperty: undefined as unknown as string,
        })
      );
      // Batch read returns results in the same order as inputs.
      const results = resp.results ?? [];
      for (let j = 0; j < chunk.length && j < results.length; j++) {
        const requested = chunk[j];
        const canonical = results[j].id;
        if (canonical) result.set(requested, canonical);
      }
    } catch (err: unknown) {
      const status = extractStatus(err);
      // If the whole batch fails, we'd ideally retry with smaller chunks.
      // For now, log and continue — the scanner can proceed without these.
      console.error(
        `batchResolveCanonicalContactIds chunk ${i}-${i + BATCH} failed (status=${status}):`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return result;
}

// Total counts via the search API (uses filterGroups=[] to return everything)
export async function getContactsTotal(): Promise<number> {
  const page = await withRetry(() =>
    hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [],
      properties: ["email"],
      limit: 1,
    })
  );
  return page.total ?? 0;
}

export async function getCompaniesTotal(): Promise<number> {
  const page = await withRetry(() =>
    hubspot.crm.companies.searchApi.doSearch({
      filterGroups: [],
      properties: ["domain"],
      limit: 1,
    })
  );
  return page.total ?? 0;
}

// Retry wrapper with exponential backoff for 429s and transient 5xxs
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const status = extractStatus(err);
      if (status !== 429 && status !== 502 && status !== 503 && status !== 504) {
        throw err;
      }
      // Exponential backoff: 500ms, 1s, 2s, 4s, 8s
      const delay = Math.min(8000, 500 * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const maybe = err as { code?: number; statusCode?: number; response?: { status?: number } };
    return maybe.code ?? maybe.statusCode ?? maybe.response?.status;
  }
  return undefined;
}
