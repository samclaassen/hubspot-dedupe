"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { mergeGroup, skipGroup } from "./actions";
import type { ReviewGroup } from "./review-dashboard";

const TIER_LABELS: Record<string, { label: string; tone: string }> = {
  tier1_linkedin: { label: "LinkedIn URL match", tone: "bg-blue-100 text-blue-900" },
  tier1_email: { label: "Email match", tone: "bg-green-100 text-green-900" },
  tier2_name_company: {
    label: "Name + Company",
    tone: "bg-amber-100 text-amber-900",
  },
  tier3_fuzzy: { label: "Fuzzy match", tone: "bg-zinc-100 text-zinc-900" },
};

// Properties we show in the diff table — just the identity-relevant ones.
// Engagement metrics and metadata are hidden to keep the card readable.
const VISIBLE_PROPS = [
  { key: "hs_object_id", label: "Record ID" },
  { key: "createdate", label: "Created" },
  { key: "hs_lastmodifieddate", label: "Last modified" },
  // Contact fields (blank for companies)
  { key: "firstname", label: "First name" },
  { key: "lastname", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "work_email", label: "Work email" },
  { key: "linkedin_profile", label: "LinkedIn" },
  { key: "company", label: "Company" },
  { key: "phone", label: "Phone" },
  // Company fields (blank for contacts)
  { key: "name", label: "Company name" },
  { key: "domain", label: "Domain" },
  { key: "website", label: "Website" },
];

export function GroupCard({
  scanId: _scanId,
  group,
}: {
  scanId: string;
  group: ReviewGroup;
}) {
  const [expanded, setExpanded] = useState(false);
  const [primaryId, setPrimaryId] = useState<string>(
    group.primaryId ?? chooseDefaultPrimary(group.members)
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(group.errorMessage);

  const displayName = deriveDisplayName(group.members[0].propertiesSnapshot);
  const secondaryName =
    group.members[1] && deriveDisplayName(group.members[1].propertiesSnapshot);
  const tier = TIER_LABELS[group.matchTier] ?? {
    label: group.matchTier,
    tone: "bg-zinc-100 text-zinc-900",
  };

  const handleSkip = () => {
    startTransition(async () => {
      const result = await skipGroup(group.id);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  const handleMerge = () => {
    setError(null);
    startTransition(async () => {
      const result = await mergeGroup(group.id, primaryId);
      if (!result.ok) setError(result.error ?? "Unknown error");
    });
  };

  return (
    <Card className={pending ? "opacity-60" : ""}>
      <CardContent className="p-0">
        <div className="flex items-center justify-between p-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((e) => !e)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded((ex) => !ex);
              }
            }}
            className="flex flex-1 cursor-pointer items-center gap-3 text-left select-none"
          >
            <span className="text-muted-foreground text-xs">
              {expanded ? "▼" : "▶"}
            </span>
            <div>
              <div className="font-medium">
                {displayName}
                {secondaryName && displayName !== secondaryName && (
                  <span className="text-muted-foreground">
                    {" — "}
                    {secondaryName}
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                <span>
                  {group.members.length} duplicate record
                  {group.members.length !== 1 && "s"}
                </span>
                <span>•</span>
                <span className={`rounded px-1.5 py-0.5 ${tier.tone}`}>
                  {tier.label}
                </span>
                <span>•</span>
                <span>{Math.round(group.matchScore * 100)}% match</span>
                {group.status === "failed" && group.errorMessage && (
                  <>
                    <span>•</span>
                    <span className="text-destructive max-w-md truncate font-medium">
                      {extractErrorSummary(group.errorMessage)}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <Badge variant={statusVariant(group.status)}>{group.status}</Badge>
            {(group.status === "pending" || group.status === "failed") && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSkip}
                  disabled={pending}
                >
                  Skip
                </Button>
                <MergeButton
                  members={group.members}
                  primaryId={primaryId}
                  pending={pending}
                  onConfirm={handleMerge}
                  isRetry={group.status === "failed"}
                />
              </>
            )}
          </div>
        </div>

        {expanded && (
          <div className="border-t p-4">
            <div className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
              Matched on:{" "}
              {Object.entries(group.matchReasons)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}
            </div>

            {group.status === "pending" && (
              <div className="mb-4">
                <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
                  Select primary record (kept after merge)
                </div>
                <RadioGroup value={primaryId} onValueChange={setPrimaryId}>
                  <div className="flex flex-wrap gap-3">
                    {group.members.map((m, i) => (
                      <label
                        key={m.id}
                        className={`hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                          primaryId === m.hubspotId ? "border-foreground bg-accent" : ""
                        }`}
                      >
                        <RadioGroupItem value={m.hubspotId} id={`${group.id}-${m.id}`} />
                        <span>
                          Record {i + 1} (#{m.hubspotId})
                        </span>
                      </label>
                    ))}
                  </div>
                </RadioGroup>
              </div>
            )}

            {error && (
              <div className="bg-destructive/10 text-destructive mb-3 rounded p-2 text-xs">
                {error}
              </div>
            )}

            <DiffTable members={group.members} primaryId={primaryId} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MergeButton({
  members,
  primaryId,
  pending,
  onConfirm,
  isRetry = false,
}: {
  members: ReviewGroup["members"];
  primaryId: string;
  pending: boolean;
  onConfirm: () => void;
  isRetry?: boolean;
}) {
  const primary = members.find((m) => m.hubspotId === primaryId);
  const secondaries = members.filter((m) => m.hubspotId !== primaryId);

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button size="sm" disabled={pending}>
            {isRetry ? "Retry merge" : "Merge"}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isRetry ? `Retry merge of ${members.length} contacts?` : `Merge ${members.length} contacts?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <strong>This cannot be undone.</strong> The primary record (#{primaryId})
            will be updated with winning field values from all records, then{" "}
            {secondaries.length} other record{secondaries.length !== 1 ? "s" : ""} will
            be merged into it via HubSpot's merge API.
            {primary && (
              <span className="mt-2 block text-xs">
                Primary:{" "}
                {deriveDisplayName(primary.propertiesSnapshot)} (#{primaryId})
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {isRetry ? "Retry" : "Merge"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function chooseDefaultPrimary(members: ReviewGroup["members"]): string {
  // Pick the most-complete record; fall back to first
  let best = members[0];
  let bestScore = countFilled(best.propertiesSnapshot);
  for (const m of members.slice(1)) {
    const s = countFilled(m.propertiesSnapshot);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best.hubspotId;
}

function countFilled(props: Record<string, string | null>): number {
  return Object.values(props).filter((v) => v && v.length > 0).length;
}

/** Extract a short human summary from a HubSpot API error blob. */
function extractErrorSummary(raw: string): string {
  // Try to pull out the top-level message
  const msgMatch = raw.match(/"message":"([^"]{5,120})"/);
  if (msgMatch) return msgMatch[1];
  // Try category
  const catMatch = raw.match(/"category":"([A-Z_]+)"/);
  if (catMatch) return `${catMatch[1]}`;
  // Fallback: first 100 chars
  return raw.slice(0, 100);
}

function DiffTable({
  members,
  primaryId,
}: {
  members: ReviewGroup["members"];
  primaryId?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs uppercase tracking-wide">
            <th className="px-2 py-2 font-medium">Property</th>
            {members.map((m, i) => (
              <th
                key={m.id}
                className={`px-2 py-2 font-medium ${
                  primaryId === m.hubspotId ? "text-foreground" : ""
                }`}
              >
                Record {i + 1} {primaryId === m.hubspotId && "★ (primary)"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {VISIBLE_PROPS.map(({ key, label }) => {
            const values = members.map((m) => m.propertiesSnapshot[key] ?? "");
            const allSame = values.every((v) => v === values[0]);
            return (
              <tr
                key={key}
                className={`border-b ${!allSame && values.some(Boolean) ? "bg-amber-50" : ""}`}
              >
                <td className="text-muted-foreground px-2 py-2 align-top font-medium">
                  {label}
                </td>
                {values.map((v, i) => (
                  <td
                    key={i}
                    className={`px-2 py-2 align-top ${
                      primaryId === members[i].hubspotId ? "font-medium" : ""
                    }`}
                  >
                    {v ? (
                      <span className="break-all">{formatValue(key, v)}</span>
                    ) : (
                      <span className="text-muted-foreground italic">—</span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function deriveDisplayName(props: Record<string, string | null>): string {
  // Contacts: firstname/lastname
  const first = props.firstname?.trim();
  const last = props.lastname?.trim();
  if (first || last) return [first, last].filter(Boolean).join(" ");
  // Companies: name, then domain, then website
  if (props.name?.trim()) return props.name.trim();
  // Contacts fallbacks
  if (props.email) return props.email;
  if (props.work_email) return props.work_email;
  if (props.linkedin_profile) return props.linkedin_profile;
  // Companies fallbacks
  if (props.domain?.trim()) return props.domain.trim();
  if (props.website?.trim()) return props.website.trim();
  return `(no name)`;
}

function statusVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "merged":
      return "default";
    case "skipped":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

function formatValue(key: string, value: string): string {
  if ((key === "createdate" || key === "hs_lastmodifieddate") && value) {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }
  return value;
}
