import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

import {
  addCalendarDays,
  selluCalendarDayWindow,
  yesterdayYmdInTimeZone,
} from "./calendar.ts";
import { getEnv, getIngestEnv, requireEnv } from "./env.ts";
import {
  extractActivityObjects,
  extractLeadObjects,
  mergeSelluPayloads,
} from "./payload_parse.ts";
import {
  activityDedupKey,
  mapActivityRow,
  mapActivityRowStaging,
  mapLeadRow,
  mapLeadRowStaging,
  resolveLeadSelluIdForActivity,
} from "./row_mappers.ts";
import { fetchSelluJson, postSelluReport } from "./sellu_api.ts";
import type { Json } from "./types.ts";

type SelluRangePayload = { start: string; end: string };

type PostResolveResult =
  | { tag: "legacy"; range: SelluRangePayload; calendarDay?: undefined }
  | { tag: "state"; range: SelluRangePayload; calendarDay: string }
  | { tag: "caught_up"; meta: Record<string, unknown> };

/**
 * Core spike flow: fetch Sell-U payload → write to Supabase (staging or normalized ingest model).
 */
export async function syncSellu(supabase: SupabaseClient): Promise<Json> {
  const tableLeads = getIngestEnv("INGEST_TABLE_LEADS", "SUPABASE_TABLE_LEADS") ?? "leads";
  const tableAct =
    getIngestEnv("INGEST_TABLE_LEADS_ACTIVITY", "SUPABASE_TABLE_LEADS_ACTIVITY") ??
    "leads_activity";
  const dbSchema = getIngestEnv("INGEST_DB_SCHEMA", "SUPABASE_DB_SCHEMA");

  function fromTable(name: string) {
    return dbSchema ? supabase.schema(dbSchema).from(name) : supabase.from(name);
  }

  async function upsertImportBatchParents(
    parentBatchTable: string,
    parentRow: Record<string, unknown>,
    onConflict: string,
    verifyCols: string[],
    importBatchId: string,
  ) {
    const batchSchemasRaw = getIngestEnv(
      "INGEST_IMPORT_BATCHES_SCHEMA",
      "SUPABASE_IMPORT_BATCHES_SCHEMA",
    )?.trim();
    const batchSchemas = batchSchemasRaw
      ? batchSchemasRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const parentTargets =
      batchSchemas.length > 0
        ? batchSchemas
        : dbSchema?.trim()
        ? [dbSchema.trim()]
        : [""];

    for (const sch of parentTargets) {
      const q = sch ? supabase.schema(sch).from(parentBatchTable) : supabase.from(parentBatchTable);
      const { error } = await q.upsert(parentRow, { onConflict });
      if (error) throw error;
    }

    for (const sch of parentTargets) {
      const q = sch ? supabase.schema(sch).from(parentBatchTable) : supabase.from(parentBatchTable);
      for (const vcol of verifyCols) {
        const { data, error } = await q.select(vcol).eq(vcol, importBatchId).maybeSingle();
        if (error) throw error;
        if (!data) {
          throw new Error(
            `import_batches row missing after upsert (schema=${sch || "default"}, column=${vcol}). ` +
              "Match SUPABASE_IMPORT_BATCH_ID_COLUMNS to the FK target column.",
          );
        }
      }
    }
  }

  const batchSizeEnv = getEnv("SELLU_UPSERT_BATCH_SIZE");
  const batchSize = Math.max(
    1,
    Number(batchSizeEnv && batchSizeEnv.length > 0 ? batchSizeEnv : "500") || 500,
  );

  const stateEnabled = getEnv("SELLU_SYNC_STATE_ENABLED") === "true";
  const timeZone = getEnv("SELLU_SYNC_TIMEZONE")?.trim() ?? "America/Bogota";
  const stateTable =
    getIngestEnv("INGEST_SYNC_STATE_TABLE", "SUPABASE_SYNC_STATE_TABLE")?.trim() ??
    "sellu_sync_state";
  const stateRowId =
    getIngestEnv("INGEST_SYNC_STATE_ID", "SUPABASE_SYNC_STATE_ID")?.trim() ?? "default";
  const advanceOnEmpty = getEnv("SELLU_SYNC_ADVANCE_ON_EMPTY") !== "false";

  async function persistSyncState(calendarYmd: string) {
    const { error } = await fromTable(stateTable).upsert(
      {
        id: stateRowId,
        last_synced_local_date: calendarYmd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  async function resolveSelluRange(): Promise<PostResolveResult> {
    if (!stateEnabled) {
      return {
        tag: "legacy",
        range: {
          start: requireEnv("SELLU_LEGACY_REPORT_START"),
          end: requireEnv("SELLU_LEGACY_REPORT_END"),
        },
      };
    }
    const yesterday = yesterdayYmdInTimeZone(timeZone);
    const first = getEnv("SELLU_SYNC_FIRST_LOCAL_DATE")?.trim();

    const { data: row, error: readErr } = await fromTable(stateTable)
      .select("last_synced_local_date")
      .eq("id", stateRowId)
      .maybeSingle();
    if (readErr) throw readErr;

    let nextDay: string;
    if (
      row?.last_synced_local_date != null &&
      String(row.last_synced_local_date).length > 0
    ) {
      const rawLast = row.last_synced_local_date as string;
      const last = rawLast.slice(0, 10);
      nextDay = addCalendarDays(last, 1);
    } else if (first) {
      nextDay = first;
    } else {
      nextDay = yesterday;
    }

    if (nextDay.localeCompare(yesterday) > 0) {
      return {
        tag: "caught_up",
        meta: {
          yesterday,
          nextDay,
          timeZone,
          stateTable,
          stateRowId,
        },
      };
    }

    const win = selluCalendarDayWindow(nextDay);
    return {
      tag: "state",
      range: { start: win.start, end: win.end },
      calendarDay: win.calendarDay,
    };
  }

  const reportUrl =
    getEnv("SELLU_REPORT_POST_URL") ?? getEnv("SELLU_REPORT_URL");
  const syncUrl = getEnv("SELLU_SYNC_URL");
  const leadsUrl = getEnv("SELLU_LEADS_URL");
  const activitiesUrl = getEnv("SELLU_ACTIVITIES_URL");
  const method = (getEnv("SELLU_HTTP_METHOD") ?? "GET").toUpperCase();

  let mergedPayload: unknown;
  let postResolved: PostResolveResult | null = null;

  if (reportUrl) {
    if (
      !getEnv("SELLU_AUTH_KEY") && !getEnv("SELLU_AUTHORIZATION") &&
      !getEnv("SELLU_API_TOKEN")
    ) {
      throw new Error(
        "Sell-U POST mode: set SELLU_AUTH_KEY (Authorization: key=…) or SELLU_AUTHORIZATION.",
      );
    }
    postResolved = await resolveSelluRange();

    if (postResolved.tag === "caught_up") {
      const m = postResolved.meta;
      return {
        ok: true,
        sync_state: "caught_up",
        message:
          `Nothing pending (next calendar day tried=${m.nextDay}, yesterday in ${m.timeZone}=${m.yesterday}).`,
        ...m,
      } as Json;
    }

    const reportWindow = postResolved.range;
    const skipActivities = getEnv("SELLU_SKIP_ACTIVITIES") === "true";
    const leadsPayload = await postSelluReport(reportUrl, "leads", reportWindow);
    const actPayload = skipActivities
      ? undefined
      : await postSelluReport(reportUrl, "actividades", reportWindow);
    mergedPayload = mergeSelluPayloads(leadsPayload, actPayload);
  } else if (syncUrl) {
    if (stateEnabled) {
      throw new Error(
        "SELLU_SYNC_STATE_ENABLED only works with SELLU_REPORT_POST_URL. Disable it or switch to POST jsnInfo.",
      );
    }
    mergedPayload = await fetchSelluJson(syncUrl, method);
    postResolved = null;
  } else if (leadsUrl) {
    if (stateEnabled) {
      throw new Error(
        "SELLU_SYNC_STATE_ENABLED only works with SELLU_REPORT_POST_URL.",
      );
    }
    const leadsPayload = await fetchSelluJson(leadsUrl, method);
    const actPayload = activitiesUrl
      ? await fetchSelluJson(activitiesUrl, method)
      : undefined;
    mergedPayload = mergeSelluPayloads(leadsPayload, actPayload);
    postResolved = null;
  } else {
    throw new Error(
      "Configure SELLU_REPORT_POST_URL (POST jsnInfo for leads/activities), or SELLU_SYNC_URL, or SELLU_LEADS_URL (optional SELLU_ACTIVITIES_URL).",
    );
  }

  const synFields = (): Record<string, unknown> =>
    postResolved?.tag !== "caught_up" && postResolved
      ? postResolved.tag === "state"
        ? {
          sellu_report_window: postResolved.range,
          sync_mode: postResolved.tag,
          sync_calendar_day: postResolved.calendarDay,
        }
        : { sellu_report_window: postResolved.range, sync_mode: postResolved.tag }
      : {};

  async function finalizeState() {
    if (postResolved?.tag === "state" && postResolved.calendarDay) {
      await persistSyncState(postResolved.calendarDay);
    }
  }

  const leadObjs = extractLeadObjects(mergedPayload);
  const activityObjs = extractActivityObjects(mergedPayload);

  if (leadObjs.length === 0) {
    if (postResolved?.tag === "state" && advanceOnEmpty && postResolved.calendarDay) {
      await persistSyncState(postResolved.calendarDay);
    }
    return {
      ok: true,
      leads_upserted: 0,
      activities_upserted: 0,
      warning: "Sell-U returned no lead-shaped rows for this reporting window.",
      activities_received: activityObjs.length,
      ...synFields(),
    } as Json;
  }

  const ingestModel =
    getIngestEnv("INGEST_MODEL", "SUPABASE_INGEST_MODEL")?.trim() ?? "normalized";

  if (ingestModel === "staging") {
    const importBatchId =
      getIngestEnv("INGEST_IMPORT_BATCH_ID", "SUPABASE_IMPORT_BATCH_ID")?.trim() ??
      crypto.randomUUID();

    const parentBatchTable = getIngestEnv(
      "INGEST_IMPORT_BATCHES_TABLE",
      "SUPABASE_IMPORT_BATCHES_TABLE",
    )?.trim();
    if (parentBatchTable) {
      let extras: Record<string, unknown> = {};
      const extraJson = getIngestEnv(
        "INGEST_IMPORT_BATCH_ROW_JSON",
        "SUPABASE_IMPORT_BATCH_ROW_JSON",
      )?.trim();
      if (extraJson) {
        try {
          extras = JSON.parse(extraJson) as Record<string, unknown>;
          if (
            extras === null || typeof extras !== "object" ||
            Array.isArray(extras)
          ) {
            throw new Error("INGEST_IMPORT_BATCH_ROW_JSON / SUPABASE_* must be an object");
          }
        } catch (e) {
          if (
            e instanceof Error &&
            (e.message.includes("INGEST_IMPORT_BATCH_ROW_JSON") ||
              e.message.includes("SUPABASE_IMPORT_BATCH_ROW_JSON"))
          ) {
            throw e;
          }
          throw new Error(
            "Invalid INGEST_IMPORT_BATCH_ROW_JSON / SUPABASE_IMPORT_BATCH_ROW_JSON (must be JSON object)",
          );
        }
      }
      const batchIdColsCsv =
        getIngestEnv("INGEST_IMPORT_BATCH_ID_COLUMNS", "SUPABASE_IMPORT_BATCH_ID_COLUMNS")
          ?.trim() ??
        getIngestEnv("INGEST_IMPORT_BATCH_ID_COLUMN", "SUPABASE_IMPORT_BATCH_ID_COLUMN")
          ?.trim() ??
        "id";
      const batchIdCols = batchIdColsCsv.split(",").map((s) => s.trim()).filter(Boolean);
      const onConflictBatch =
        getIngestEnv("INGEST_IMPORT_BATCH_ON_CONFLICT", "SUPABASE_IMPORT_BATCH_ON_CONFLICT")
          ?.trim() ?? batchIdCols[0];

      const parentRow: Record<string, unknown> = { ...extras };
      for (const c of batchIdCols) parentRow[c] = importBatchId;

      await upsertImportBatchParents(
        parentBatchTable,
        parentRow,
        onConflictBatch,
        batchIdCols,
        importBatchId,
      );
    }

    let leadSeq = 0;
    const leadStagingRows = leadObjs.map((obj) => {
      leadSeq++;
      return mapLeadRowStaging(obj, leadSeq, importBatchId);
    });

    let leadsUpsertCount = 0;
    for (let i = 0; i < leadStagingRows.length; i += batchSize) {
      const chunk = leadStagingRows.slice(i, i + batchSize);
      const { data: insertedLeads, error: leadsErr } = await fromTable(tableLeads)
        .insert(chunk)
        .select("id");
      if (leadsErr) throw leadsErr;
      leadsUpsertCount += insertedLeads?.length ?? 0;
    }

    let activitiesUpserted = 0;
    if (activityObjs.length > 0) {
      let actSeq = 0;
      const activityStagingRows: Record<string, unknown>[] = [];
      for (const a of activityObjs) {
        const aglead = resolveLeadSelluIdForActivity(a);
        if (!aglead) continue;
        actSeq++;
        activityStagingRows.push(mapActivityRowStaging(aglead, a, actSeq, importBatchId));
      }

      for (let i = 0; i < activityStagingRows.length; i += batchSize) {
        const chunk = activityStagingRows.slice(i, i + batchSize);
        if (chunk.length === 0) continue;
        const { data: actData, error: actError } = await fromTable(tableAct)
          .insert(chunk)
          .select("id");
        if (actError) throw actError;
        activitiesUpserted += actData?.length ?? 0;
      }
    }

    await finalizeState();

    return {
      ok: true,
      ingest_model: "staging",
      import_batch_id: importBatchId,
      leads_upserted: leadsUpsertCount,
      activities_upserted: activitiesUpserted,
      leads_received: leadObjs.length,
      activities_received: activityObjs.length,
      batch_size: batchSize,
      ...synFields(),
      destination: {
        schema: dbSchema ?? "public",
        table_leads: tableLeads,
        table_leads_activity: tableAct,
      },
    } as Json;
  }

  const leadRows = leadObjs.map(mapLeadRow).map((r) => ({
    ...r,
    synced_at: new Date().toISOString(),
  }));

  const selluToUuid = new Map<string, string>();
  let leadsUpsertCount = 0;

  for (let i = 0; i < leadRows.length; i += batchSize) {
    const chunk = leadRows.slice(i, i + batchSize);
    const { data: upsertedLeads, error: leadsError } = await fromTable(tableLeads)
      .upsert(chunk, { onConflict: "sellu_id" })
      .select("id, sellu_id");

    if (leadsError) throw leadsError;
    leadsUpsertCount += upsertedLeads?.length ?? 0;
    for (const row of upsertedLeads ?? []) {
      const r = row as { id: string; sellu_id: string };
      selluToUuid.set(r.sellu_id, r.id);
    }
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

    for (let i = 0; i < withSync.length; i += batchSize) {
      const chunk = withSync.slice(i, i + batchSize);
      if (chunk.length === 0) continue;

      const { data: actData, error: actError } = await fromTable(tableAct)
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
    leads_upserted: leadsUpsertCount,
    activities_upserted: activitiesUpserted,
    leads_received: leadObjs.length,
    activities_received: activityObjs.length,
    batch_size: batchSize,
    ...synFields(),
    destination: {
      schema: dbSchema ?? "public",
      table_leads: tableLeads,
      table_leads_activity: tableAct,
    },
  } as Json;
}
