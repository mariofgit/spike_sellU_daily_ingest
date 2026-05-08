import type { Json } from "./types.ts";

function pickString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickOptionalString(
  r: Record<string, unknown>,
  keys: string[],
): string | null | undefined {
  const s = pickString(r, keys);
  return s ?? null;
}

/** Separa blobs fecha/hora Sell-U para columnas staging. */
export function splitDateTimeRaw(
  v: unknown,
): { date: string | null; time: string | null } {
  if (v == null || v === "") return { date: null, time: null };
  const s = String(v).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]+(\S+)/);
  if (iso) return { date: iso[1]!, time: iso[2]! };
  const sp = s.search(/\s/);
  if (sp > 0) return { date: s.slice(0, sp), time: s.slice(sp + 1).trim() };
  return { date: s, time: null };
}

export function mapLeadRow(raw: Json): {
  sellu_id: string;
  email: string | null;
  full_name: string | null;
  company: string | null;
  status: string | null;
  metadata: Json;
  raw: Json;
} {
  const sellu_id = pickString(raw, [
    "AgLead",
    "sellu_id",
    "external_id",
    "id",
    "lead_id",
    "crm_id",
  ]);
  if (!sellu_id) {
    throw new Error("Lead has no stable id (sellu_id / external id)");
  }

  const email = pickOptionalString(raw, ["email", "mail", "primary_email"]);
  const full_name = pickOptionalString(raw, [
    "Titulo",
    "full_name",
    "name",
    "display_name",
    "first_name",
  ]);
  const company = pickOptionalString(raw, [
    "Distribuidor",
    "Grupo",
    "company",
    "company_name",
    "organization",
    "organization_name",
  ]);
  const status = pickOptionalString(raw, [
    "Estatus",
    "status",
    "stage",
    "state",
  ]);

  const metadata: Json = { ...raw };
  for (
    const k of [
      "email",
      "mail",
      "full_name",
      "name",
      "company",
      "status",
      "raw",
    ]
  ) {
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

export async function activityDedupKey(
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

  const type = pickString(a, [
    "Estatus",
    "type",
    "activity_type",
    "kind",
  ]) ?? "";
  const at = pickString(a, [
    "ActividadFecha",
    "occurred_at",
    "created_at",
    "updated_at",
    "date",
  ]) ?? "";
  const body = pickString(a, [
    "Actividad",
    "body",
    "note",
    "description",
    "subject",
    "title",
  ]) ?? "";
  const h = await sha256Hex(`${leadSelluId}|${type}|${at}|${body}`);
  return `gen:${h.slice(0, 40)}`;
}

export function mapActivityRow(
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
    "Estatus",
    "type",
    "activity_type",
    "kind",
    "category",
  ]);
  const subject = pickOptionalString(raw, [
    "Campaña",
    "Campana",
    "Campaing",
    "subject",
    "title",
    "name",
  ]);
  const body = pickOptionalString(raw, [
    "Actividad",
    "body",
    "note",
    "description",
  ]);
  const occurred = pickString(raw, [
    "ActividadFecha",
    "occurred_at",
    "created_at",
    "updated_at",
    "date",
    "time",
  ]);
  const occurred_at = occurred ? new Date(occurred).toISOString() : null;

  const metadata: Json = { ...raw };
  for (
    const k of [
      "subject",
      "title",
      "body",
      "note",
      "Actividad",
      "ActividadFecha",
      "Estatus",
      "Campaña",
      "Campana",
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

export function resolveLeadSelluIdForActivity(a: Json): string | undefined {
  return pickString(a, [
    "AgLead",
    "lead_sellu_id",
    "lead_id",
    "parent_id",
    "lead_external_id",
    "contact_id",
  ]);
}

export function mapLeadRowStaging(
  raw: Json,
  sourceRowNumber: number,
  importBatchId: string,
): Record<string, unknown> {
  const aglead = pickString(raw, [
    "AgLead",
    "sellu_id",
    "external_id",
    "id",
    "lead_id",
    "crm_id",
  ]);
  if (!aglead) throw new Error("Lead has no AgLead / external id");
  const origin = pickOptionalString(raw, [
    "FechaOrigen",
    "fecha_origen",
    "fechaOrigen",
    "FechaCreacion",
    "created_at",
    "fecha_creacion",
  ]);
  const org = splitDateTimeRaw(origin);
  return {
    import_batch_id: importBatchId,
    source_row_number: sourceRowNumber,
    aglead,
    fecha_origen_raw: org.date,
    hora_origen_raw: org.time,
    distribuidor: pickOptionalString(raw, ["Distribuidor", "distribuidor"]),
    grupo: pickOptionalString(raw, ["Grupo", "grupo"]),
    marca: pickOptionalString(raw, ["Marca", "marca", "AgMarca", "AgMarcaGrupo"]),
    producto: pickOptionalString(raw, ["Producto", "producto"]),
    asesor: pickOptionalString(raw, ["Asesor", "asesor"]),
    campania: pickOptionalString(raw, ["Campaña", "Campana", "Campaing", "campania"]),
    subcampania: pickOptionalString(raw, ["SubCampaña", "SubCampana", "subcampania", "Subcampania"]),
    fuente: pickOptionalString(raw, ["Fuente", "fuente"]),
    medio_atencion: pickOptionalString(raw, [
      "MedioAtencion",
      "medio_atencion",
      "Medio_Atencion",
    ]),
    titulo_lead: pickOptionalString(raw, [
      "Titulo",
      "full_name",
      "name",
      "display_name",
      "first_name",
    ]),
    temperatura: pickOptionalString(raw, ["Temperatura", "temperatura"]),
    estatus: pickOptionalString(raw, ["Estatus", "status", "stage", "state"]),
    motivo_finalizacion: pickOptionalString(raw, [
      "MotivoFinalizacion",
      "motivo_finalizacion",
      "Motivo",
      "motivo",
    ]),
    raw_payload: raw,
  };
}

export function mapActivityRowStaging(
  aglead: string,
  a: Json,
  sourceRowNumber: number,
  importBatchId: string,
): Record<string, unknown> {
  const occurred = pickOptionalString(a, [
    "ActividadFecha",
    "occurred_at",
    "created_at",
    "updated_at",
    "date",
    "time",
  ]);
  const occ = splitDateTimeRaw(occurred);
  const prog = pickOptionalString(a, [
    "FechaProgramada",
    "fecha_programada",
    "FechaProg",
    "scheduled_at",
  ]);
  const pr = splitDateTimeRaw(prog);
  return {
    import_batch_id: importBatchId,
    source_row_number: sourceRowNumber,
    aglead,
    fecha_actividad_raw: occ.date,
    hora_actividad_raw: occ.time,
    fecha_programada_raw: pr.date,
    hora_programada_raw: pr.time,
    distribuidor: pickOptionalString(a, ["Distribuidor", "distribuidor"]),
    grupo: pickOptionalString(a, ["Grupo", "grupo"]),
    marca: pickOptionalString(a, ["Marca", "marca", "AgMarca", "AgMarcaGrupo"]),
    producto: pickOptionalString(a, ["Producto", "producto"]),
    asesor: pickOptionalString(a, ["Asesor", "asesor"]),
    campania: pickOptionalString(a, ["Campaña", "Campana", "Campaing", "campania"]),
    subcampania: pickOptionalString(a, ["SubCampaña", "SubCampana", "subcampania", "Subcampania"]),
    fuente: pickOptionalString(a, ["Fuente", "fuente"]),
    actividad: pickOptionalString(a, ["Actividad", "body", "note", "description"]),
    estatus_actividad: pickOptionalString(a, [
      "Estatus",
      "EstatusActividad",
      "estatus_actividad",
      "type",
      "activity_type",
      "kind",
      "category",
    ]),
    temperatura: pickOptionalString(a, ["Temperatura", "temperatura"]),
    raw_payload: a,
  };
}
