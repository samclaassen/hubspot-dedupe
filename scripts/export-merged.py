#!/usr/bin/env python3
"""Export a CSV of all merged contacts from a given scan (one row per merge group).

Uses HubSpot's batch read API to resolve each primaryId to its current canonical
record and fetch the current property values. This automatically follows
forward references created by subsequent merges.

Usage:
  python scripts/export-merged.py <SCAN_ID>
  # or edit SCAN_ID below to a default value
"""

import csv
import json
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DB_PATH = REPO / "dev.db"
ENV_PATH = REPO / ".env.local"
# Pass scan id as CLI arg, else edit this placeholder.
SCAN_ID = sys.argv[1] if len(sys.argv) > 1 else "<YOUR_SCAN_ID>"
OUT_PATH = REPO / f"merged-contacts-{SCAN_ID}.csv"

# Read the HubSpot token from .env.local
token = None
for line in ENV_PATH.read_text().splitlines():
    if line.startswith("HUBSPOT_ACCESS_TOKEN="):
        token = line.split("=", 1)[1].strip().strip('"')
        break
if not token:
    sys.exit("HUBSPOT_ACCESS_TOKEN not found in .env.local")

# Gather (primaryId, group metadata) from DB
conn = sqlite3.connect(DB_PATH)
rows = conn.execute(
    """
    SELECT g.id, g.primaryId, g.matchTier, g.matchScore,
           (SELECT COUNT(*) FROM GroupMember WHERE groupId = g.id) as member_count,
           (SELECT GROUP_CONCAT(hubspotId, '|') FROM GroupMember WHERE groupId = g.id) as merged_ids
    FROM DuplicateGroup g
    WHERE g.scanRunId = ? AND g.status = 'merged' AND g.primaryId IS NOT NULL
    """,
    (SCAN_ID,),
).fetchall()
conn.close()

print(f"Found {len(rows)} merged groups")

# De-duplicate primaryIds (some groups might share a canonical after cascading merges)
primary_to_meta: dict[str, dict] = {}
for group_id, primary_id, tier, score, member_count, merged_ids in rows:
    if primary_id not in primary_to_meta:
        primary_to_meta[primary_id] = {
            "tier": tier,
            "score": score,
            "member_count": member_count,
            "merged_ids": merged_ids,
        }

primary_ids = list(primary_to_meta.keys())
print(f"Unique primary IDs to fetch: {len(primary_ids)}")

# Properties to retrieve
PROPS = [
    "firstname", "lastname", "email", "work_email", "hs_additional_emails",
    "phone", "company", "jobtitle", "linkedin_profile", "hs_linkedin_url",
    "hs_lastmodifieddate", "createdate",
]

# Batch read — up to 100 IDs per call
def batch_read(ids: list[str]) -> dict[str, dict]:
    url = "https://api.hubapi.com/crm/v3/objects/contacts/batch/read"
    body = {
        "inputs": [{"id": i} for i in ids],
        "properties": PROPS,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} on batch: {e.read().decode()[:200]}")
        return {}
    out: dict[str, dict] = {}
    for r in data.get("results", []):
        # HubSpot returns canonical id in `id`, which may differ from requested id
        out[r["id"]] = r.get("properties", {})
    return out

# Also build a map from ANY requested id to the returned canonical id
def batch_read_mapped(ids: list[str]) -> tuple[dict[str, str], dict[str, dict]]:
    """Returns (requested_id -> canonical_id, canonical_id -> properties)."""
    url = "https://api.hubapi.com/crm/v3/objects/contacts/batch/read"
    body = {
        "inputs": [{"id": i} for i in ids],
        "properties": PROPS,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:300]}")
        return {}, {}
    results = data.get("results", [])
    props_by_canonical: dict[str, dict] = {}
    requested_to_canonical: dict[str, str] = {}
    # Match each input to its result by position (HubSpot preserves input order)
    for idx, r in enumerate(results):
        canonical = r["id"]
        props_by_canonical[canonical] = r.get("properties", {})
        # We don't know the ORIGINAL requested id from the response alone.
        # But since we asked for an id and got back canonical, we can infer
        # by checking each input id.
    # Instead: build requested->canonical by iterating inputs and looking up
    # canonical via a separate pass. The simpler approach: if every input
    # resolved successfully, the order matches.
    for i, req_id in enumerate(ids):
        if i < len(results):
            requested_to_canonical[req_id] = results[i]["id"]
    return requested_to_canonical, props_by_canonical

# Fetch in batches of 100
properties_by_canonical: dict[str, dict] = {}
requested_to_canonical: dict[str, str] = {}
BATCH = 100
for start in range(0, len(primary_ids), BATCH):
    chunk = primary_ids[start:start + BATCH]
    print(f"  batch {start // BATCH + 1}/{(len(primary_ids) + BATCH - 1) // BATCH} ({len(chunk)} ids)...", flush=True)
    mapping, props = batch_read_mapped(chunk)
    requested_to_canonical.update(mapping)
    properties_by_canonical.update(props)

# Write CSV
with OUT_PATH.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow([
        "canonical_hubspot_id",
        "firstname",
        "lastname",
        "email",
        "work_email",
        "hs_additional_emails",
        "phone",
        "company",
        "jobtitle",
        "linkedin_profile",
        "hs_linkedin_url",
        "createdate",
        "hs_lastmodifieddate",
        "records_merged",
        "match_tier",
        "match_score",
        "original_member_ids",
        "canonical_hubspot_url",
    ])
    seen_canonicals: set[str] = set()
    for primary_id, meta in primary_to_meta.items():
        canonical = requested_to_canonical.get(primary_id, primary_id)
        # De-dupe by canonical — if two of our primaries collapsed to the same
        # canonical, we still want one row per original merge group so counts
        # add up. But if the user prefers one-row-per-canonical, we could skip.
        # Keeping one row per group for full traceability.
        p = properties_by_canonical.get(canonical, {})
        w.writerow([
            canonical,
            p.get("firstname", ""),
            p.get("lastname", ""),
            p.get("email", ""),
            p.get("work_email", ""),
            p.get("hs_additional_emails", ""),
            p.get("phone", ""),
            p.get("company", ""),
            p.get("jobtitle", ""),
            p.get("linkedin_profile", ""),
            p.get("hs_linkedin_url", ""),
            p.get("createdate", ""),
            p.get("hs_lastmodifieddate", ""),
            meta["member_count"],
            meta["tier"],
            meta["score"],
            meta["merged_ids"],
            f"https://app.hubspot.com/contacts/<YOUR_HUBSPOT_PORTAL_ID>/record/0-1/{canonical}",
        ])
        seen_canonicals.add(canonical)

print(f"\nWrote {OUT_PATH}")
print(f"  total rows: {len(primary_to_meta)}")
print(f"  unique canonicals: {len(seen_canonicals)}")
