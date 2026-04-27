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
// Exported so auditor modules share the same semaphore.
export const limit = pLimit(8);

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
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
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

// ============================================================
// Cleanup audit helpers (added Stage 1 of the HubSpot cleanup tool)
// ============================================================

export type SupportedAuditObjectType = "contacts" | "companies" | "deals";

export type HubSpotProperty = {
  name: string;
  label: string;
  type: string; // dataType: string | number | date | datetime | bool | enumeration
  fieldType: string; // UI field type: text | textarea | select | date | ...
  groupName: string;
  description?: string;
  hidden?: boolean;
  formField?: boolean;
  hubspotDefined?: boolean;
  calculated?: boolean;
  calculationFormula?: string;
  modificationMetadata?: {
    archivable: boolean;
    readOnlyDefinition: boolean;
    readOnlyValue: boolean;
  };
  updatedAt?: string;
};

/** List all non-archived properties for a given object type. */
export async function listProperties(
  objectType: SupportedAuditObjectType
): Promise<HubSpotProperty[]> {
  const resp = await withRetry(() =>
    hubspot.crm.properties.coreApi.getAll(objectType, false)
  );
  return resp.results as unknown as HubSpotProperty[];
}

/** Fetch a single property's current metadata (used for safety re-fetch before archive). */
export async function getProperty(
  objectType: SupportedAuditObjectType,
  propertyName: string
): Promise<HubSpotProperty> {
  const resp = await withRetry(() =>
    hubspot.crm.properties.coreApi.getByName(objectType, propertyName, false)
  );
  return resp as unknown as HubSpotProperty;
}

/** List property groups (used to surface whole-group cleanup candidates). */
export async function listPropertyGroups(objectType: SupportedAuditObjectType) {
  const resp = await withRetry(() =>
    hubspot.crm.properties.groupsApi.getAll(objectType)
  );
  return resp.results;
}

/** Archive (soft-delete, 90-day recovery) a property. Requires write scope. */
export async function archiveProperty(
  objectType: SupportedAuditObjectType,
  propertyName: string
): Promise<void> {
  await withRetry(() =>
    hubspot.crm.properties.coreApi.archive(objectType, propertyName)
  );
}

/**
 * Count records that have a non-null value for the given property using
 * the Search API's HAS_PROPERTY filter with limit=1 (we only need `total`).
 * This is the primary "is this property populated?" signal for the audit.
 */
export async function countRecordsWithProperty(
  objectType: SupportedAuditObjectType,
  propertyName: string
): Promise<number> {
  const searchApi =
    objectType === "contacts"
      ? hubspot.crm.contacts.searchApi
      : objectType === "companies"
        ? hubspot.crm.companies.searchApi
        : hubspot.crm.deals.searchApi;

  const page = await withRetry(() =>
    searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName,
              // SDK exports one enum per object type (contacts/companies/deals)
              // with identical runtime values. Cast to never to share call shape.
              operator: "HAS_PROPERTY" as never,
            },
          ],
        },
      ],
      properties: ["hs_object_id"],
      sorts: [],
      limit: 1,
      after: "0",
    })
  );
  return page.total ?? 0;
}

/** Total number of deal records (companion to getContactsTotal / getCompaniesTotal). */
export async function getDealsTotal(): Promise<number> {
  const page = await withRetry(() =>
    hubspot.crm.deals.searchApi.doSearch({
      filterGroups: [],
      properties: ["dealname"],
      limit: 1,
    })
  );
  return page.total ?? 0;
}

// ============================================================
// Lists / segments
// ============================================================

export type HubSpotList = {
  listId: string;
  listVersion?: number;
  name: string;
  processingType: "MANUAL" | "DYNAMIC" | "SNAPSHOT";
  processingStatus?: string;
  objectTypeId: string; // "0-1" contacts, "0-2" companies, etc.
  createdAt: string;
  updatedAt: string;
  filtersUpdatedAt?: string | null;
  createdById?: string | null;
  updatedById?: string | null;
  additionalProperties?: {
    hs_list_reference_count?: string;
    hs_last_record_added_at?: string;
    hs_last_record_removed_at?: string;
    hs_list_size?: string;
  };
};

/**
 * Paginate all lists via POST /crm/v3/lists/search.
 *
 * We intentionally use POST /search (not GET /crm/v3/lists) because the GET
 * endpoint returns an empty array when no listIds are specified. The search
 * endpoint is the canonical way to enumerate all lists and also returns
 * `additionalProperties` (reference count, last-added, last-removed timestamps)
 * that give us real staleness signals.
 */
export async function* paginateLists(): AsyncGenerator<HubSpotList[]> {
  let offset = 0;
  const COUNT = 100;
  while (true) {
    const page = await withRetry(async () => {
      const res = (await hubspot.apiRequest({
        method: "POST",
        path: "/crm/v3/lists/search",
        body: { count: COUNT, offset } as never,
      })) as unknown as Response;
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`HubSpot lists search ${res.status}: ${body.slice(0, 200)}`), {
          code: res.status,
          body,
        });
      }
      return (await res.json()) as {
        offset: number;
        hasMore: boolean;
        lists: HubSpotList[];
      };
    });

    if (page.lists.length === 0) break;
    yield page.lists;
    if (!page.hasMore) break;
    offset = page.offset;
  }
}

/** Fetch a single list's details (used for safety re-fetch before delete). */
export async function getListDetails(listId: string): Promise<HubSpotList> {
  return withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "GET",
      path: `/crm/v3/lists/${listId}`,
    })) as unknown as Response;
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`HubSpot list ${listId} ${res.status}: ${body.slice(0, 200)}`), {
        code: res.status,
        body,
      });
    }
    const payload = (await res.json()) as { list?: HubSpotList } | HubSpotList;
    return "list" in payload && payload.list ? payload.list : (payload as HubSpotList);
  });
}

/** Delete a list. Hard delete — no recovery. Callers must pre-check references. */
export async function deleteList(listId: string): Promise<void> {
  await withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "DELETE",
      path: `/crm/v3/lists/${listId}`,
    })) as unknown as Response;
    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      throw Object.assign(new Error(`HubSpot list delete ${listId} ${res.status}: ${body.slice(0, 200)}`), {
        code: res.status,
        body,
      });
    }
  });
}

// ============================================================
// Workflows (/automation/v4/flows)
// Used by the property auditor to detect workflow references.
// (List audit gets reference counts via hs_list_reference_count — no
// workflow iteration needed for lists.)
// ============================================================

export type HubSpotWorkflowSummary = {
  id: string;
  isEnabled: boolean;
  flowType: string;
  objectTypeId: string;
  revisionId: string;
  name: string;
  uuid?: string;
  createdAt: string;
  updatedAt: string;
};

export type HubSpotWorkflowDetail = HubSpotWorkflowSummary & {
  actions?: unknown[];
  enrollmentCriteria?: unknown;
  [key: string]: unknown;
};

/** Paginate workflow summaries (lightweight — does not include full definitions). */
export async function* paginateWorkflows(): AsyncGenerator<HubSpotWorkflowSummary[]> {
  let after: string | undefined = undefined;
  const LIMIT = 100;
  while (true) {
    const page = await withRetry(async () => {
      const path =
        `/automation/v4/flows?limit=${LIMIT}` +
        (after ? `&after=${encodeURIComponent(after)}` : "");
      const res = (await hubspot.apiRequest({ method: "GET", path })) as unknown as Response;
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`HubSpot workflows ${res.status}: ${body.slice(0, 200)}`), {
          code: res.status,
          body,
        });
      }
      return (await res.json()) as {
        results: HubSpotWorkflowSummary[];
        paging?: { next?: { after?: string } };
      };
    });

    if (page.results.length === 0) break;
    yield page.results;
    after = page.paging?.next?.after;
    if (!after) break;
  }
}

/**
 * Fetch a workflow's full definition. The definition is a large JSON blob;
 * the property auditor stringifies it and substring-searches for property
 * names rather than traversing the graph.
 */
export async function getWorkflowDefinition(flowId: string): Promise<HubSpotWorkflowDetail> {
  return withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "GET",
      path: `/automation/v4/flows/${flowId}`,
    })) as unknown as Response;
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`HubSpot workflow ${flowId} ${res.status}: ${body.slice(0, 200)}`), {
        code: res.status,
        body,
      });
    }
    return (await res.json()) as HubSpotWorkflowDetail;
  });
}

// ============================================================
// Forms (/marketing/v3/forms)
//
// Uses GET /marketing/v3/forms for enumeration + detail,
// /form-integrations/v1/submissions/forms/{id} for last-submission timestamp,
// and PATCH /marketing/v3/forms/{id} to archive (soft-delete).
// ============================================================

export type HubSpotForm = {
  id: string;
  name: string;
  formType: string; // hubspot | flow | native | ...
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  fieldGroups?: Array<{
    fields?: Array<{ name: string; [k: string]: unknown }>;
    [k: string]: unknown;
  }>;
  [key: string]: unknown;
};

/** Paginate all non-archived forms. */
export async function* paginateForms(): AsyncGenerator<HubSpotForm[]> {
  let after: string | undefined = undefined;
  const LIMIT = 100;
  while (true) {
    const page = await withRetry(async () => {
      const path =
        `/marketing/v3/forms?limit=${LIMIT}` +
        (after ? `&after=${encodeURIComponent(after)}` : "");
      const res = (await hubspot.apiRequest({
        method: "GET",
        path,
      })) as unknown as Response;
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`HubSpot forms ${res.status}: ${body.slice(0, 200)}`), {
          code: res.status,
          body,
        });
      }
      return (await res.json()) as {
        results: HubSpotForm[];
        paging?: { next?: { after?: string } };
      };
    });

    if (page.results.length === 0) break;
    yield page.results;
    after = page.paging?.next?.after;
    if (!after) break;
  }
}

/** Fetch a single form's current detail (for safety re-fetch before archive). */
export async function getForm(formId: string): Promise<HubSpotForm> {
  return withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "GET",
      path: `/marketing/v3/forms/${formId}`,
    })) as unknown as Response;
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`HubSpot form ${formId} ${res.status}: ${body.slice(0, 200)}`), {
        code: res.status,
        body,
      });
    }
    return (await res.json()) as HubSpotForm;
  });
}

/**
 * Get the most recent form submission timestamp (ms since epoch), or null
 * if the form has never been submitted.
 *
 * Uses /form-integrations/v1/submissions/forms/{id}?limit=1 which returns
 * submissions sorted newest-first.
 */
export async function getLatestFormSubmissionAt(
  formId: string
): Promise<number | null> {
  return withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "GET",
      path: `/form-integrations/v1/submissions/forms/${formId}?limit=1`,
    })) as unknown as Response;
    if (!res.ok) {
      // 404 = form has no submissions table (never submitted). Other errors bubble up.
      if (res.status === 404) return null;
      const body = await res.text();
      throw Object.assign(
        new Error(`HubSpot form submissions ${formId} ${res.status}: ${body.slice(0, 200)}`),
        { code: res.status, body }
      );
    }
    const body = (await res.json()) as {
      results?: Array<{ submittedAt?: number }>;
    };
    const first = body.results?.[0];
    return first?.submittedAt ?? null;
  });
}

/**
 * Archive a form (soft delete — reversible via the same endpoint with
 * archived=false). Uses PATCH /marketing/v3/forms/{id}.
 */
export async function archiveForm(formId: string): Promise<void> {
  await withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "PATCH",
      path: `/marketing/v3/forms/${formId}`,
      body: { archived: true } as never,
    })) as unknown as Response;
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`HubSpot form archive ${formId} ${res.status}: ${body.slice(0, 200)}`),
        { code: res.status, body }
      );
    }
  });
}

/**
 * Disable a workflow via PUT /automation/v4/flows/{flowId} with isEnabled=false.
 * HubSpot's v4 API requires the full flow JSON for updates, so we fetch first,
 * mutate `isEnabled`, then PUT back. Reversible — flip isEnabled=true to restore.
 *
 * Returns the updated flow detail.
 */
export async function disableWorkflow(flowId: string): Promise<HubSpotWorkflowDetail> {
  const current = await getWorkflowDefinition(flowId);
  if (current.isEnabled === false) {
    // Already disabled — no-op, return current state.
    return current;
  }
  const body = { ...current, isEnabled: false };

  return withRetry(async () => {
    const res = (await hubspot.apiRequest({
      method: "PUT",
      path: `/automation/v4/flows/${flowId}`,
      body: body as never,
    })) as unknown as Response;
    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(
        new Error(`HubSpot workflow PUT ${flowId} ${res.status}: ${text.slice(0, 300)}`),
        { code: res.status, body: text }
      );
    }
    return (await res.json()) as HubSpotWorkflowDetail;
  });
}
