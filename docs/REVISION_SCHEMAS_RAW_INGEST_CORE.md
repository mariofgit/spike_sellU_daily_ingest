# Revisión de schemas: raw, ingest y core

**Proyecto:** RYD Bases — Supabase · **Fecha:** 2026-05-20  
**Contexto:** Sell-U (`sellu-daily-sync`) → `raw`; promoción a `core` vía colas y funciones en Postgres.

---

## Resumen

| Capa | Rol |
|------|-----|
| **raw** | Landing fiel (texto + `raw_payload`) |
| **ingest** | Lotes, colas, validación |
| **core** | BI: `dim_*` + `fact_*` |

**Contrato:** raw = etiquetas de origen; core = UUIDs de dimensiones + fechas parseadas. Clave de negocio del lead: **`aglead`**. Sell-U solo escribe **raw**; promoción con `core.sync_raw_*_batch`.

**Trazabilidad:** un UUID en `ingest.import_batches` enlaza raw → `pending_sync_jobs` → `fact_*` (`source_import_batch_id`). Triggers en raw encolan; cron cada **5 min** ejecuta `process_pending_sync_jobs`.

**Duplicidad:** cabecera canónica = **`ingest.import_batches`** (`raw.import_batches` vacía en prod). Texto en raw + UUID en core y `raw_payload` son intencionales.

**En una frase:** medallion coherente — raw (llegada), ingest (control), core (analítica); trazable por lote en `ingest.import_batches`.

### Normalización por schema

| Schema / objeto | 1FN | 2FN | 3FN | 4FN |
|---------------|-----|-----|-----|-----|
| **raw** | Cumple* | No | No | No |
| **ingest** | Cumple | Cumple | Cumple | Cumple |
| **core** (`dim_*`) | Cumple | Cumple | Cumple | Cumple |
| **core** (`fact_*`) | Cumple | Parcial | No | N/A |

\* 1FN a nivel columna; fechas en texto y `raw_payload` = staging.

---

## 1. Contrato raw → core

Implementado en `core.sync_raw_leads_batch` y `core.sync_raw_lead_activities_batch`.

**Leads (resumen):** `aglead` → `aglead`; `distribuidor`/`grupo`/`marca`/`producto`/`asesor`/`campania`/`fuente` → `*_id` vía `dim_*`; fechas raw → `lead_origin_*`; atributos directos (`temperatura`, `estatus`, …); `import_batch_id` → `source_import_batch_id`; `raw_payload` no sube a core.

**Actividades:** `aglead` → FK a `fact_leads`; fechas raw → `activity_ts` / `planned_ts`; `actividad` / `estatus_actividad`; dimensiones se resuelven otra vez en el sync.

---

## 2. Trazabilidad

```
Sell-U → Edge → ingest.import_batches → raw.* (+ import_batch_id)
       → trigger → ingest.pending_sync_jobs → sync_raw_*_batch → core.fact_*
```

Estado revisado (2026-05-20): ~1.69M filas raw vs ~1.10M `fact_leads`; lotes Sell-U recientes pueden quedar en raw con jobs **pending** hasta que corre la cola.

---

## 3. Duplicidad

- **Canónico:** `ingest.import_batches` (FK de todas las `raw_*`).
- **Legacy / vacío:** `raw.import_batches`, `public.*` del spike local.
- **Intencional:** columnas parseadas + `raw_payload`; varios lotes el mismo día = catch-up trazable.

---

## Referencias

- [ARCHITECTURE.md](./ARCHITECTURE.md) — pipeline Sell-U y cron diario
- Funciones clave: `process_pending_sync_jobs`, `sync_raw_leads_batch`, `enqueue_raw_leads_sync_job`
