import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.49.8";

type Json = Record<string, unknown>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function getEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

function requireEnv(name: string): string {
  const v = getEnv(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function authorize(req: Request): void {
  const cronSecret = getEnv("CRON_SECRET");
  if (!cronSecret) return;

  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : undefined;
  const header = req.headers.get("x-cron-secret");
  const ok = bearer === cronSecret || header === cronSecret;
  if (!ok) throw new Error("Unauthorized");
}

/** Cabeceras HTTP hacia Sell-U (reportes POST). Authorization: key=&lt;token&gt; */
function selluUpstreamHeaders(): HeadersInit {
  const authKey = getEnv("SELLU_AUTH_KEY");
  const authFull = getEnv("SELLU_AUTHORIZATION");
  const legacyBearer = getEnv("SELLU_API_TOKEN");
  const extra = getEnv("SELLU_EXTRA_HEADERS_JSON");

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };

  if (authFull) {
    headers.authorization = authFull;
  } else if (authKey) {
    headers.authorization = `key=${authKey}`;
  } else if (legacyBearer) {
    headers.authorization = `Bearer ${legacyBearer}`;
  }

  if (extra) {
    try {
      Object.assign(headers, JSON.parse(extra) as Record<string, string>);
    } catch {
      throw new Error("Invalid SELLU_EXTRA_HEADERS_JSON");
    }
  }

  return headers;
}

function buildJsnInfo(tipoReporte: "leads" | "actividades"): Json {
  const secret = requireEnv("SELLU_SECRET_TOKEN_APP");
  const marca = getEnv("SELLU_AG_MARCA_GRUPO") ?? "MG";
  const desde = requireEnv("SELLU_FECHA_INICIO");
  const hasta = requireEnv("SELLU_FECHA_FIN");

  return {
    infoAuthApp: { sSecretTokenApp: secret },
    infoJSON: {
      AgMarcaGrupo: marca,
      tipoReporte,
      fechaInicio: desde,
      fechaFinal: hasta,
    },
  };
}

/** POST con cuerpo form: jsnInfo=&lt;JSON escapado&gt; (contrato Sell-U). */
async function postSelluReport(
  url: string,
  tipoReporte: "leads" | "actividades",
): Promise<unknown> {
  const jsnInfo = buildJsnInfo(tipoReporte);
  const body = new URLSearchParams();
  body.set("jsnInfo", JSON.stringify(jsnInfo));

  const res = await fetch(url, {
    method: "POST",
    headers: selluUpstreamHeaders(),
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sell-U POST (${tipoReporte}) HTTP ${res.status}: ${text.slice(0, 800)}`,
    );
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return await res.json();
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Sell-U: respuesta no JSON (${tipoReporte}), primeros bytes: ${text.slice(0, 200)}`,
    );
  }
}

async function fetchSelluJson(url: string, method: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const authKey = getEnv("SELLU_AUTH_KEY");
  const authFull = getEnv("SELLU_AUTHORIZATION");
  const token = getEnv("SELLU_API_TOKEN");

  if (authFull) headers.authorization = authFull;
  else if (authKey) headers.authorization = `key=${authKey}`;
  else if (token) headers.authorization = `Bearer ${token}`;

  const extra = getEnv("SELLU_EXTRA_HEADERS_JSON");
  if (extra) {
    try {
      Object.assign(headers, JSON.parse(extra) as Record<string, string>);
    } catch {
      throw new Error("Invalid SELLU_EXTRA_HEADERS_JSON");
    }
  }

  const res = await fetch(url, { method, headers });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Sell-U HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  return await res.json();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickOptionalString(r: Record<string, unknown>, keys: string[]): string | null | undefined {
  const s = pickString(r, keys);
  return s ?? null;
}

/** Intenta reconocer un array de leads en distintos contenedores habituales. */
function extractLeadObjects(payload: unknown): Json[] {
  if (Array.isArray(payload)) {
    return payload.filter((x): x is Json => asRecord(x) !== null);
  }
  const root = asRecord(payload);
  if (!root) return [];

  const candidates = [
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

/** Intenta reconocer actividades anidadas o en lista plana. */
function extractActivityObjects(payload: unknown): Json[] {
  const root = asRecord(payload);
  if (!root) return [];

  const direct = [
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

function mapLeadRow(raw: Json): {
  sellu_id: string;
  email: string | null;
  full_name: string | null;
  company: string | null;
  status: string | null;
  metadata: Json;
  raw: Json;
} {
  const sellu_id = pickString(raw, [
    "sellu_id",
    "external_id",
    "id",
    "lead_id",
    "crm_id",
  ]);
  if (!sellu_id) {
    throw new Error("Lead sin identificador (sellu_id / id)");
  }

  const email = pickOptionalString(raw, ["email", "mail", "primary_email"]);
  const full_name = pickOptionalString(raw, [
    "full_name",
    "name",
    "display_name",
    "first_name",
  ]);
  const company = pickOptionalString(raw, [
    "company",
    "company_name",
    "organization",
    "organization_name",
  ]);
  const status = pickOptionalString(raw, ["status", "stage", "state"]);

  const metadata: Json = { ...raw };
  for (const k of [
    "email",
    "mail",
    "full_name",
    "name",
    "company",
    "status",
    "raw",
  ]) {
    delete metadata[k];
  }

  return {
    sellu_id,
    email: email ?? null,
    full_name: full_name ?? null,
    company: company ?? null,
    status: status ?? null,
    metadata,
    raw,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function activityDedupKey(
  leadSelluId: string,
  a: Json,
): Promise<string> {
  const existing = pickString(a, [
    "sellu_activity_id",
    "id",
    "activity_id",
    "external_id",
  ]);
  if (existing) return existing;

  const type = pickString(a, ["type", "activity_type", "kind"]) ?? "";
  const at = pickString(a, [
    "occurred_at",
    "created_at",
    "updated_at",
    "date",
  ]) ?? "";
  const body = pickString(a, ["body", "note", "description", "subject", "title"]) ??
    "";
  const h = await sha256Hex(`${leadSelluId}|${type}|${at}|${body}`);
  return `gen:${h.slice(0, 40)}`;
}

function mapActivityRow(
  sellu_activity_id: string,
  leadUuid: string,
  raw: Json,
): {
  lead_id: string;
  sellu_activity_id: string;
  activity_type: string | null;
  subject: string | null;
  body: string | null;
  occurred_at: string | null;
  metadata: Json;
  raw: Json;
} {
  const activity_type = pickOptionalString(raw, [
    "type",
    "activity_type",
    "kind",
    "category",
  ]);
  const subject = pickOptionalString(raw, ["subject", "title", "name"]);
  const body = pickOptionalString(raw, ["body", "note", "description"]);
  const occurred = pickString(raw, [
    "occurred_at",
    "created_at",
    "updated_at",
    "date",
    "time",
  ]);
  const occurred_at = occurred
    ? new Date(occurred).toISOString()
    : null;

  const metadata: Json = { ...raw };
  for (
    const k of [
      "subject",
      "title",
      "body",
      "note",
      "occurred_at",
      "created_at",
      "id",
    ]
  ) {
    delete metadata[k];
  }

  return {
    lead_id: leadUuid,
    sellu_activity_id,
    activity_type: activity_type ?? null,
    subject: subject ?? null,
    body: body ?? null,
    occurred_at,
    metadata,
    raw,
  };
}

function resolveLeadSelluIdForActivity(a: Json): string | undefined {
  return pickString(a, [
    "lead_sellu_id",
    "lead_id",
    "parent_id",
    "lead_external_id",
    "contact_id",
  ]);
}

/** Une la respuesta de leads + activities cuando vienen de dos llamadas HTTP. */
function mergeSelluPayloads(
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

async function syncSellu(supabase: SupabaseClient): Promise<Json> {
  const reportUrl =
    getEnv("SELLU_REPORT_POST_URL") ?? getEnv("SELLU_REPORT_URL");
  const syncUrl = getEnv("SELLU_SYNC_URL");
  const leadsUrl = getEnv("SELLU_LEADS_URL");
  const activitiesUrl = getEnv("SELLU_ACTIVITIES_URL");
  const method = (getEnv("SELLU_HTTP_METHOD") ?? "GET").toUpperCase();

  let mergedPayload: unknown;

  if (reportUrl) {
    if (
      !getEnv("SELLU_AUTH_KEY") && !getEnv("SELLU_AUTHORIZATION") &&
      !getEnv("SELLU_API_TOKEN")
    ) {
      throw new Error(
        "Modo POST Sell-U: define SELLU_AUTH_KEY (cabecera Authorization: key=…) o SELLU_AUTHORIZATION completa",
      );
    }
    const skipActivities = getEnv("SELLU_SKIP_ACTIVITIES") === "true";
    const leadsPayload = await postSelluReport(reportUrl, "leads");
    const actPayload = skipActivities
      ? undefined
      : await postSelluReport(reportUrl, "actividades");
    mergedPayload = mergeSelluPayloads(leadsPayload, actPayload);
  } else if (syncUrl) {
    mergedPayload = await fetchSelluJson(syncUrl, method);
  } else if (leadsUrl) {
    const leadsPayload = await fetchSelluJson(leadsUrl, method);
    const actPayload = activitiesUrl
      ? await fetchSelluJson(activitiesUrl, method)
      : undefined;
    mergedPayload = mergeSelluPayloads(leadsPayload, actPayload);
  } else {
    throw new Error(
      "Configura SELLU_REPORT_POST_URL (POST jsnInfo leads/actividades), o SELLU_SYNC_URL, o SELLU_LEADS_URL (+ opcional SELLU_ACTIVITIES_URL)",
    );
  }

  const leadObjs = extractLeadObjects(mergedPayload);
  const activityObjs = extractActivityObjects(mergedPayload);

  if (leadObjs.length === 0) {
    return {
      ok: true,
      leads_upserted: 0,
      activities_upserted: 0,
      warning: "No se encontraron objetos de lead en la respuesta",
      activities_received: activityObjs.length,
    };
  }

  const leadRows = leadObjs.map(mapLeadRow).map((r) => ({
    ...r,
    synced_at: new Date().toISOString(),
  }));

  const { data: upsertedLeads, error: leadsError } = await supabase
    .from("leads")
    .upsert(leadRows, { onConflict: "sellu_id" })
    .select("id, sellu_id");

  if (leadsError) throw leadsError;

  const selluToUuid = new Map<string, string>();
  for (const row of upsertedLeads ?? []) {
    const r = row as { id: string; sellu_id: string };
    selluToUuid.set(r.sellu_id, r.id);
  }

  let activitiesUpserted = 0;

  if (activityObjs.length > 0) {
    const activityRows: ReturnType<typeof mapActivityRow>[] = [];

    for (const a of activityObjs) {
      const leadSellu = resolveLeadSelluIdForActivity(a);
      if (!leadSellu) continue;
      const leadUuid = selluToUuid.get(String(leadSellu));
      if (!leadUuid) continue;

      const dedup = await activityDedupKey(leadSellu, a);
      activityRows.push(mapActivityRow(dedup, leadUuid, a));
    }

    const withSync = activityRows.map((r) => ({
      ...r,
      synced_at: new Date().toISOString(),
    }));

    if (withSync.length > 0) {
      const { data: actData, error: actError } = await supabase
        .from("leads_activity")
        .upsert(withSync, { onConflict: "sellu_activity_id" })
        .select("id");

      if (actError) throw actError;
      activitiesUpserted = actData?.length ?? 0;
    }
  }

  return {
    ok: true,
    leads_upserted: upsertedLeads?.length ?? leadRows.length,
    activities_upserted: activitiesUpserted,
    leads_received: leadObjs.length,
    activities_received: activityObjs.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    authorize(req);

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceKey);

    const summary = await syncSellu(supabase);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message === "Unauthorized" ? 401 : 500;
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
