/**
 * Split Sell-U/API-style date/time text (ISO-ish or "YYYY-MM-DD HH:mm…") into { date, time }.
 */
function splitDateTimeRaw(v) {
  if (v == null || v === "") return { date: null, time: null };
  const s = String(v).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]+(\S+)/);
  if (iso) return { date: iso[1], time: iso[2] };
  const sp = s.search(/\s/);
  if (sp > 0) return { date: s.slice(0, sp), time: s.slice(sp + 1).trim() };
  return { date: s, time: null };
}

/** Add calendar days to an ISO calendar date string (YYYY-MM-DD). UTC math only on the calendar number. */
function addCalendarDays(ymdStr, deltaDays) {
  const [y0, mo0, d0] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y0, mo0 - 1, d0 + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function todayYmdInTimeZone(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function yesterdayYmdInTimeZone(timeZone) {
  return addCalendarDays(todayYmdInTimeZone(timeZone), -1);
}

function selluCalendarDayWindow(calendarYmd) {
  return {
    start: `${calendarYmd} 00:00:00`,
    end: `${calendarYmd} 23:59:59`,
    calendarDay: calendarYmd,
  };
}

/**
 * Sell-U → Postgres sync engine (same behaviour as the Edge Function).
 * @param {(name: string) => string | undefined} getEnv
 */
export function makeSyncSellu(getEnv) {
  function requireEnv(name) {
    const v = getEnv(name);
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
  }

  function buildJsnInfo(reportType, start, end) {
    const secret = requireEnv("SELLU_SECRET_TOKEN_APP");
    const brandGroup = getEnv("SELLU_BRAND_GROUP") ?? "MG";
    return {
      infoAuthApp: { sSecretTokenApp: secret },
      infoJSON: {
        AgMarcaGrupo: brandGroup,
        tipoReporte: reportType,
        fechaInicio: start,
        fechaFinal: end,
      },
    };
  }

  function selluUpstreamHeaders() {
    const authKey = getEnv("SELLU_AUTH_KEY");
    const authFull = getEnv("SELLU_AUTHORIZATION");
    const legacyBearer = getEnv("SELLU_API_TOKEN");
    const extra = getEnv("SELLU_EXTRA_HEADERS_JSON");
    const headers = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    };
    if (authFull) headers.authorization = authFull;
    else if (authKey) headers.authorization = `key=${authKey}`;
    else if (legacyBearer) headers.authorization = `Bearer ${legacyBearer}`;
    if (extra) {
      try {
        Object.assign(headers, JSON.parse(extra));
      } catch {
        throw new Error("Invalid SELLU_EXTRA_HEADERS_JSON");
      }
    }
    return headers;
  }

  async function postSelluReport(url, reportType, window) {
    const jsnInfo = buildJsnInfo(reportType, window.start, window.end);
    const body = new URLSearchParams();
    body.set("jsnInfo", JSON.stringify(jsnInfo));
    const res = await fetch(url, {
      method: "POST",
      headers: selluUpstreamHeaders(),
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sell-U POST (${reportType}) HTTP ${res.status}: ${text.slice(0, 800)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return res.json();
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Sell-U: response is not JSON (${reportType})`);
    }
  }

  function asRecord(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  }

  function pickString(r, keys) {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return undefined;
  }

  function pickOptionalString(r, keys) {
    const s = pickString(r, keys);
    return s ?? null;
  }

  function extractLeadObjects(payload) {
    if (Array.isArray(payload)) {
      return payload.filter((x) => asRecord(x));
    }
    const root = asRecord(payload);
    if (!root) return [];
    const candidates = [
      root.rrRecibidos,
      root.leads,
      root.lead_list,
      root.items,
      root.data,
      root.results,
      root.registros,
      root.resultado,
      root.reporte,
    ];
    for (const c of candidates) {
      if (Array.isArray(c)) return c.filter((x) => asRecord(x));
      const rec = asRecord(c);
      if (rec?.leads && Array.isArray(rec.leads)) {
        return rec.leads.filter((x) => asRecord(x));
      }
    }
    return [];
  }

  function extractActivityObjects(payload) {
    const root = asRecord(payload);
    if (!root) return [];
    const direct = [
      root.rrActividades,
      root.activities,
      root.lead_activities,
      root.events,
      root.tasks,
      root.notes,
      root.actividades,
      root.listaActividades,
    ];
    for (const c of direct) {
      if (Array.isArray(c)) return c.filter((x) => asRecord(x));
    }
    const leads = extractLeadObjects(payload);
    const nested = [];
    for (const lead of leads) {
      for (const k of ["activities", "lead_activities", "events"]) {
        const s = lead[k];
        if (Array.isArray(s)) {
          for (const item of s) {
            if (asRecord(item)) nested.push(item);
          }
        }
      }
    }
    return nested;
  }

  function mapLeadRow(raw) {
    const sellu_id = pickString(raw, [
      "AgLead",
      "sellu_id",
      "external_id",
      "id",
      "lead_id",
      "crm_id",
    ]);
    if (!sellu_id) throw new Error("Lead has no stable id (sellu_id / external id)");
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
    const status = pickOptionalString(raw, ["Estatus", "status", "stage", "state"]);
    const metadata = { ...raw };
    for (const k of ["email", "mail", "full_name", "name", "company", "status", "raw"]) {
      delete metadata[k];
    }
    return { sellu_id, email: email ?? null, full_name: full_name ?? null, company: company ?? null, status: status ?? null, metadata, raw };
  }

  async function sha256Hex(input) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function activityDedupKey(leadSelluId, a) {
    const existing = pickString(a, ["sellu_activity_id", "id", "activity_id", "external_id"]);
    if (existing) return existing;
    const type = pickString(a, ["Estatus", "type", "activity_type", "kind"]) ?? "";
    const at =
      pickString(a, ["ActividadFecha", "occurred_at", "created_at", "updated_at", "date"]) ?? "";
    const body =
      pickString(a, ["Actividad", "body", "note", "description", "subject", "title"]) ?? "";
    const h = await sha256Hex(`${leadSelluId}|${type}|${at}|${body}`);
    return `gen:${h.slice(0, 40)}`;
  }

  function mapActivityRow(sellu_activity_id, leadUuid, raw) {
    const activity_type = pickOptionalString(raw, ["Estatus", "type", "activity_type", "kind", "category"]);
    const subject = pickOptionalString(raw, ["Campaña", "Campana", "Campaing", "subject", "title", "name"]);
    const body = pickOptionalString(raw, ["Actividad", "body", "note", "description"]);
    const occurred = pickString(raw, ["ActividadFecha", "occurred_at", "created_at", "updated_at", "date", "time"]);
    const occurred_at = occurred ? new Date(occurred).toISOString() : null;
    const metadata = { ...raw };
    for (const k of [
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
    ]) {
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

  function resolveLeadSelluIdForActivity(a) {
    return pickString(a, ["AgLead", "lead_sellu_id", "lead_id", "parent_id", "lead_external_id", "contact_id"]);
  }

  /** Staging table shape: bigint ids, import_batch_id, aglead, raw_payload, … */
  function mapLeadRowStaging(raw, sourceRowNumber, importBatchId) {
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
      medio_atencion: pickOptionalString(raw, ["MedioAtencion", "medio_atencion", "Medio_Atencion"]),
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

  function mapActivityRowStaging(aglead, a, sourceRowNumber, importBatchId) {
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

  function mergeSelluPayloads(leadsPayload, activitiesPayload) {
    if (activitiesPayload === undefined) {
      if (Array.isArray(leadsPayload)) return { leads: leadsPayload };
      return leadsPayload;
    }
    if (Array.isArray(leadsPayload) && Array.isArray(activitiesPayload)) {
      return { leads: leadsPayload, activities: activitiesPayload };
    }
    if (asRecord(leadsPayload) && Array.isArray(activitiesPayload)) {
      return { ...asRecord(leadsPayload), activities: activitiesPayload };
    }
    if (Array.isArray(leadsPayload) && asRecord(activitiesPayload)) {
      return { leads: leadsPayload, ...asRecord(activitiesPayload) };
    }
    return { ...(asRecord(leadsPayload) ?? {}), ...(asRecord(activitiesPayload) ?? {}) };
  }

  const defaultBatch = 500;

  return async function syncSellu(supabase) {
    function ingestEnv(primary, fallback) {
      const a = getEnv(primary);
      if (a !== undefined && String(a).trim() !== "") return String(a).trim();
      const b = getEnv(fallback);
      if (b !== undefined && String(b).trim() !== "") return String(b).trim();
      return undefined;
    }

    const tableLeads = ingestEnv("INGEST_TABLE_LEADS", "SUPABASE_TABLE_LEADS") ?? "leads";
    const tableAct =
      ingestEnv("INGEST_TABLE_LEADS_ACTIVITY", "SUPABASE_TABLE_LEADS_ACTIVITY") ??
      "leads_activity";
    const dbSchema = ingestEnv("INGEST_DB_SCHEMA", "SUPABASE_DB_SCHEMA"); // empty = public

    function from(name) {
      return dbSchema ? supabase.schema(dbSchema).from(name) : supabase.from(name);
    }

    const stateEnabled = getEnv("SELLU_SYNC_STATE_ENABLED") === "true";
    const timeZone = getEnv("SELLU_SYNC_TIMEZONE")?.trim() || "America/Bogota";
    const stateTable =
      ingestEnv("INGEST_SYNC_STATE_TABLE", "SUPABASE_SYNC_STATE_TABLE")?.trim() ||
      "sellu_sync_state";
    const stateRowId =
      ingestEnv("INGEST_SYNC_STATE_ID", "SUPABASE_SYNC_STATE_ID")?.trim() || "default";
    const advanceOnEmpty = getEnv("SELLU_SYNC_ADVANCE_ON_EMPTY") !== "false";

    async function persistSyncState(calendarYmd) {
      const { error } = await from(stateTable).upsert(
        {
          id: stateRowId,
          last_synced_local_date: calendarYmd,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (error) throw error;
    }

    async function resolveSelluRange() {
      if (!stateEnabled) {
        return {
          tag: "legacy",
          range: {
            start: requireEnv("SELLU_LEGACY_REPORT_START"),
            end: requireEnv("SELLU_LEGACY_REPORT_END"),
          },
          calendarDay: undefined,
          meta: {},
        };
      }

      const yesterday = yesterdayYmdInTimeZone(timeZone);
      const first = getEnv("SELLU_SYNC_FIRST_LOCAL_DATE")?.trim();

      const { data: row, error: readErr } = await from(stateTable)
        .select("last_synced_local_date")
        .eq("id", stateRowId)
        .maybeSingle();
      if (readErr) throw readErr;

      let nextDay;
      if (row?.last_synced_local_date != null && row.last_synced_local_date !== "") {
        const rawLast = row.last_synced_local_date;
        const last =
          typeof rawLast === "string" ? rawLast.slice(0, 10) : String(rawLast).slice(0, 10);
        nextDay = addCalendarDays(last, 1);
      } else if (first) {
        nextDay = first;
      } else {
        nextDay = yesterday;
      }

      if (nextDay.localeCompare(yesterday) > 0) {
        return {
          tag: "caught_up",
          meta: { yesterday, nextDay, timeZone, stateTable, stateRowId },
        };
      }

      const win = selluCalendarDayWindow(nextDay);
      return {
        tag: "state",
        range: { start: win.start, end: win.end },
        calendarDay: win.calendarDay,
        meta: {
          yesterday,
          timeZone,
          stateTable,
          stateRowId,
        },
      };
    }

    const reportUrl = getEnv("SELLU_REPORT_POST_URL") ?? getEnv("SELLU_REPORT_URL");
    if (!reportUrl) {
      throw new Error("Set SELLU_REPORT_POST_URL or SELLU_REPORT_URL");
    }
    if (!getEnv("SELLU_AUTH_KEY") && !getEnv("SELLU_AUTHORIZATION") && !getEnv("SELLU_API_TOKEN")) {
      throw new Error("Sell-U POST requires SELLU_AUTH_KEY, SELLU_AUTHORIZATION or SELLU_API_TOKEN");
    }

    const resolved = await resolveSelluRange();
    if (resolved.tag === "caught_up") {
      const m = resolved.meta;
      return {
        ok: true,
        sync_state: "caught_up",
        message:
          `Nothing pending (next calendar day tried=${m.nextDay}, yesterday in ${m.timeZone}=${m.yesterday}).`,
        ...m,
      };
    }

    const reportWindow = resolved.range;

    const skipActivities = getEnv("SELLU_SKIP_ACTIVITIES") === "true";
    const leadsPayload = await postSelluReport(reportUrl, "leads", reportWindow);
    const actPayload = skipActivities ? undefined : await postSelluReport(reportUrl, "actividades", reportWindow);
    const mergedPayload = mergeSelluPayloads(leadsPayload, actPayload);

    const leadObjs = extractLeadObjects(mergedPayload);
    const activityObjs = extractActivityObjects(mergedPayload);

    if (leadObjs.length === 0) {
      if (resolved.tag === "state" && advanceOnEmpty && resolved.calendarDay) {
        await persistSyncState(resolved.calendarDay);
      }
      return {
        ok: true,
        leads_upserted: 0,
        activities_upserted: 0,
        warning: "Sell-U returned no lead-shaped rows for this reporting window.",
        activities_received: activityObjs.length,
        sellu_report_window: reportWindow,
        sync_mode: resolved.tag,
        ...(resolved.calendarDay ? { sync_calendar_day: resolved.calendarDay } : {}),
      };
    }

    async function finalizeState() {
      if (resolved.tag === "state" && resolved.calendarDay) {
        await persistSyncState(resolved.calendarDay);
      }
    }
    const batchSize = Math.max(1, Number(getEnv("SELLU_UPSERT_BATCH_SIZE") || defaultBatch) || defaultBatch);

    const ingestModel = ingestEnv("INGEST_MODEL", "SUPABASE_INGEST_MODEL")?.trim() || "normalized";

    if (ingestModel === "staging") {
      const importBatchId =
        ingestEnv("INGEST_IMPORT_BATCH_ID", "SUPABASE_IMPORT_BATCH_ID")?.trim() ||
        crypto.randomUUID();

      const parentBatchTable = ingestEnv(
        "INGEST_IMPORT_BATCHES_TABLE",
        "SUPABASE_IMPORT_BATCHES_TABLE",
      )?.trim();
      if (parentBatchTable) {
        const batchIdColsCsv =
          ingestEnv("INGEST_IMPORT_BATCH_ID_COLUMNS", "SUPABASE_IMPORT_BATCH_ID_COLUMNS")
            ?.trim() ||
          ingestEnv("INGEST_IMPORT_BATCH_ID_COLUMN", "SUPABASE_IMPORT_BATCH_ID_COLUMN")
            ?.trim() ||
          "id";
        const batchIdCols = batchIdColsCsv.split(",").map((s) => s.trim()).filter(Boolean);
        const onConflictBatch =
          ingestEnv("INGEST_IMPORT_BATCH_ON_CONFLICT", "SUPABASE_IMPORT_BATCH_ON_CONFLICT")?.trim() ||
          batchIdCols[0];
        const batchSchemasRaw = ingestEnv(
          "INGEST_IMPORT_BATCHES_SCHEMA",
          "SUPABASE_IMPORT_BATCHES_SCHEMA",
        )?.trim();
        const batchSchemas = batchSchemasRaw
          ? batchSchemasRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        /** Unset → same schema as staging tables. Comma list = dual-write (e.g. raw,public) when FK target is ambiguous. */
        const parentTargets =
          batchSchemas.length > 0
            ? batchSchemas
            : [dbSchema?.trim() ? dbSchema.trim() : ""];

        let extras = {};
        const extraJson = ingestEnv(
          "INGEST_IMPORT_BATCH_ROW_JSON",
          "SUPABASE_IMPORT_BATCH_ROW_JSON",
        )?.trim();
        if (extraJson) {
          try {
            extras = JSON.parse(extraJson);
            if (
              extras === null || typeof extras !== "object" || Array.isArray(extras)
            ) {
              throw new SyntaxError("not_plain_object");
            }
          } catch {
            throw new Error(
              "Invalid INGEST_IMPORT_BATCH_ROW_JSON / SUPABASE_IMPORT_BATCH_ROW_JSON (must be JSON object)",
            );
          }
        }
        const parentRow = { ...extras };
        for (const c of batchIdCols) parentRow[c] = importBatchId;

        for (const sch of parentTargets) {
          const q = sch
            ? supabase.schema(sch).from(parentBatchTable)
            : supabase.from(parentBatchTable);
          const { error: parentErr } = await q.upsert(parentRow, {
            onConflict: onConflictBatch,
          });
          if (parentErr) throw parentErr;
        }
        for (const sch of parentTargets) {
          const q = sch
            ? supabase.schema(sch).from(parentBatchTable)
            : supabase.from(parentBatchTable);
          for (const vcol of batchIdCols) {
            const { data: parentCheck, error: checkErr } = await q
              .select(vcol)
              .eq(vcol, importBatchId)
              .maybeSingle();
            if (checkErr) throw checkErr;
            if (!parentCheck) {
              throw new Error(
                `import_batches parent row not visible after upsert (schema=${sch || "default"}, ${vcol}=${importBatchId}). ` +
                  `Tune SUPABASE_IMPORT_BATCH_ID_COLUMNS / ON_CONFLICT to match pg_get_constraintdef on raw.raw_leads.`,
              );
            }
          }
        }
      }

      let leadSeq = 0;
      const leadStagingRows = leadObjs.map((obj) => {
        leadSeq++;
        return mapLeadRowStaging(obj, leadSeq, importBatchId);
      });

      let leadsUpserted = 0;
      for (let i = 0; i < leadStagingRows.length; i += batchSize) {
        const chunk = leadStagingRows.slice(i, i + batchSize);
        const { data: insertedLeads, error: leadsErr } = await from(tableLeads).insert(chunk).select("id");
        if (leadsErr) throw leadsErr;
        leadsUpserted += insertedLeads?.length ?? 0;
      }

      let activitiesUpserted = 0;
      if (activityObjs.length > 0) {
        let actSeq = 0;
        const activityStagingRows = [];
        for (const a of activityObjs) {
          const aglead = resolveLeadSelluIdForActivity(a);
          if (!aglead) continue;
          actSeq++;
          activityStagingRows.push(mapActivityRowStaging(aglead, a, actSeq, importBatchId));
        }

        for (let i = 0; i < activityStagingRows.length; i += batchSize) {
          const chunk = activityStagingRows.slice(i, i + batchSize);
          if (chunk.length === 0) continue;
          const { data: actData, error: actError } = await from(tableAct).insert(chunk).select("id");
          if (actError) throw actError;
          activitiesUpserted += actData?.length ?? 0;
        }
      }

      await finalizeState();

      return {
        ok: true,
        ingest_model: "staging",
        import_batch_id: importBatchId,
        leads_upserted: leadsUpserted,
        activities_upserted: activitiesUpserted,
        leads_received: leadObjs.length,
        activities_received: activityObjs.length,
        batch_size: batchSize,
        sellu_report_window: reportWindow,
        sync_mode: resolved.tag,
        ...(resolved.calendarDay ? { sync_calendar_day: resolved.calendarDay } : {}),
        destination: {
          schema: dbSchema ?? "public",
          table_leads: tableLeads,
          table_leads_activity: tableAct,
        },
      };
    }

    const leadRows = leadObjs.map(mapLeadRow).map((r) => ({
      ...r,
      synced_at: new Date().toISOString(),
    }));

    const selluToUuid = new Map();
    let leadsUpserted = 0;
    for (let i = 0; i < leadRows.length; i += batchSize) {
      const chunk = leadRows.slice(i, i + batchSize);
      const { data: upsertedLeads, error: leadsError } = await from(tableLeads)
        .upsert(chunk, { onConflict: "sellu_id" })
        .select("id, sellu_id");
      if (leadsError) throw leadsError;
      leadsUpserted += upsertedLeads?.length ?? 0;
      for (const row of upsertedLeads ?? []) {
        selluToUuid.set(row.sellu_id, row.id);
      }
    }

    let activitiesUpserted = 0;
    if (activityObjs.length > 0) {
      const activityRows = [];
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

      for (let i = 0; i < withSync.length; i += batchSize) {
        const chunk = withSync.slice(i, i + batchSize);
        if (chunk.length === 0) continue;
        const { data: actData, error: actError } = await from(tableAct)
          .upsert(chunk, { onConflict: "sellu_activity_id" })
          .select("id");
        if (actError) throw actError;
        activitiesUpserted += actData?.length ?? 0;
      }
    }

    await finalizeState();

    return {
      ok: true,
      ingest_model: "normalized",
      leads_upserted: leadsUpserted,
      activities_upserted: activitiesUpserted,
      leads_received: leadObjs.length,
      activities_received: activityObjs.length,
      batch_size: batchSize,
      sellu_report_window: reportWindow,
      sync_mode: resolved.tag,
      ...(resolved.calendarDay ? { sync_calendar_day: resolved.calendarDay } : {}),
      destination: {
        schema: dbSchema ?? "public",
        table_leads: tableLeads,
        table_leads_activity: tableAct,
      },
    };
  };
}
