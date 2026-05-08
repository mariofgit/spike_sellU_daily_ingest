import type { Json } from "./types.ts";

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function mergeSelluPayloads(
  leadsPayload: unknown,
  activitiesPayload: unknown | undefined,
): unknown {
  if (activitiesPayload === undefined) {
    if (Array.isArray(leadsPayload)) return { leads: leadsPayload };
    return leadsPayload;
  }

  if (Array.isArray(leadsPayload) && Array.isArray(activitiesPayload)) {
    return { leads: leadsPayload, activities: activitiesPayload };
  }

  if (asRecord(leadsPayload) && Array.isArray(activitiesPayload)) {
    return { ...asRecord(leadsPayload)!, activities: activitiesPayload };
  }

  if (Array.isArray(leadsPayload) && asRecord(activitiesPayload)) {
    return { leads: leadsPayload, ...asRecord(activitiesPayload)! };
  }

  const left = asRecord(leadsPayload) ?? {};
  const right = asRecord(activitiesPayload) ?? {};
  return { ...left, ...right };
}

/** Best-effort: extract a leads array from heterogeneous Sell-U payloads. */
export function extractLeadObjects(payload: unknown): Json[] {
  if (Array.isArray(payload)) {
    return payload.filter((x): x is Json => asRecord(x) !== null);
  }
  const root = asRecord(payload);
  if (!root) return [];

  const candidates = [
    root["rrRecibidos"],
    root["leads"],
    root["lead_list"],
    root["items"],
    root["data"],
    root["results"],
    root["registros"],
    root["resultado"],
    root["reporte"],
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((x): x is Json => asRecord(x) !== null);
    }
    if (asRecord(c)?.["leads"] && Array.isArray(asRecord(c)!["leads"])) {
      return (asRecord(c)!["leads"] as unknown[]).filter((x): x is Json =>
        asRecord(x) !== null
      );
    }
  }
  return [];
}

/** Activities at payload root or nested under leads. */
export function extractActivityObjects(payload: unknown): Json[] {
  const root = asRecord(payload);
  if (!root) return [];

  const direct = [
    root["rrActividades"],
    root["activities"],
    root["lead_activities"],
    root["events"],
    root["tasks"],
    root["notes"],
    root["actividades"],
    root["listaActividades"],
  ];

  for (const c of direct) {
    if (Array.isArray(c)) {
      return c.filter((x): x is Json => asRecord(x) !== null);
    }
  }

  const leads = extractLeadObjects(payload);
  const nested: Json[] = [];
  for (const lead of leads) {
    const subs = [
      lead["activities"],
      lead["lead_activities"],
      lead["events"],
    ];
    for (const s of subs) {
      if (Array.isArray(s)) {
        for (const item of s) {
          if (asRecord(item)) nested.push(item as Json);
        }
      }
    }
  }
  return nested;
}
