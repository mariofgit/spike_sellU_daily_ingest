# Revisión de schemas: raw, ingest y core

**Proyecto:** RYD Bases — Supabase  
**Fecha:** 2026-05-20  
**Tipo de revisión:** análisis cualitativo de diseño y estado operativo (no auditoría de datos fila a fila).

---

## Veredicto general

El modelo de tres capas (**raw → ingest → core**) es **sólido y coherente** con un patrón medallion / Kimball bien aplicado: cada schema tiene un contrato claro y no compite con el otro. La calidad del diseño es **alta en ingest y core (dimensiones)**; **raw cumple su rol de staging** aunque, por definición, no aspire a normalización analítica.

Lo que más suma al negocio es la **trazabilidad por lote** (`ingest.import_batches`) y la **separación entre “como llegó” y “como se consulta”**. Lo que requiere atención operativa no es el dibujo del modelo, sino la **latencia de la cola** raw→core cuando entran muchos lotes seguidos (p. ej. catch-up de Sell-U): los datos están enlazados, pero pueden vivir un tiempo solo en raw.

| Dimensión | Valoración cualitativa |
|-----------|------------------------|
| Claridad de capas | Alta |
| Trazabilidad end-to-end | Alta |
| Normalización (según rol de cada capa) | Adecuada |
| Deuda / ambigüedad en convenciones | Baja–media (tablas legacy del spike) |
| Madurez operativa (mayo 2026) | Buena en ingestión; cola raw→core con backlog puntual |

---

## Las tres capas (lectura cualitativa)

### `raw` — calidad de landing

**Propósito cumplido:** conservar el payload de origen (columnas de reporte + `raw_payload`) sin forzar tipos ni dimensiones prematuras. Para Sell-U y cargas similares, esto es la decisión correcta: reduce fricción en la ingesta y deja evidencia para reprocesos.

**Fortalezas:** nombres alineados al reporte (`distribuidor`, `campania`, `fecha_*_raw`); FK uniforme a `ingest.import_batches`; triggers que encolan promoción sin acoplar la Edge Function al modelo analítico.

**Limitaciones (esperadas):** repetición de atributos de dimensión en cada fila y fechas en texto. No son defectos de modelado, sino **deuda consciente** a favor de simplicidad y auditoría.

### `ingest` — calidad de orquestación

**Propósito cumplido:** ser la “memoria del pipeline”: qué lote entró, de dónde, cuántas filas, si falló, y qué trabajo falta ejecutar.

**Fortalezas:** `import_batches` con metadata rica; `pending_sync_jobs` desacopla escritura masiva en raw del trabajo pesado de resolución de dimensiones; encaje natural con cron y funciones `enqueue_*` / `process_pending_sync_jobs`.

**Observación:** esta capa es la más **normalizada** del sistema y la que mejor resistiría un examen OLTP clásico. Es el ancla de trazabilidad real en producción.

### `core` — calidad del modelo analítico

**Propósito cumplido:** exponer hechos y dimensiones listos para BI, con claves surrogate (`uuid`) y claves de negocio estables (`aglead`, `dealer_code`, `brand_name`, etc.).

**Fortalezas:** dimensiones con unicidad explícita; hechos con FKs a `dim_*` y a `fact_leads` vía `aglead`; `source_import_batch_id` permite auditar qué carga originó cada fila en core.

**Trade-off deliberado:** `fact_lead_activities` repite FKs de dimensión aunque el lead ya exista en `fact_leads`. Es **star schema**, no fallo de 3FN: prioriza consultas sobre pureza relacional.

---

## 1. Contrato entre capas

El contrato **no está documentado en el repo del spike**; vive en Postgres (`core.sync_raw_leads_batch`, `core.sync_raw_lead_activities_batch`). Aun así, es **estable y predecible**:

- **Semántica:** texto y fechas crudas en raw → IDs tipados y timestamps en core.
- **Clave de negocio del lead:** `aglead` (única en `fact_leads`).
- **Resolución de dimensiones:** lookup por nombre/código hacia `dim_*`; si no hay match, el hecho suele quedar con FK nulo (comportamiento típico de ETL).
- **Auditoría:** `raw_payload` permanece en raw; no se promueve a core.

**Calidad del contrato:** **buena**. Hay un solo camino oficial raw→core (cola + funciones), sin atajos que escriban hechos desde la Edge de Sell-U. Eso protege la consistencia del modelo estrella.

**Leads (mapa resumido):** dimensiones (`distribuidor` → `dealer_id`, `marca` → `brand_id`, …); fechas raw → `lead_origin_*`; atributos de estado/título directos; lote → `source_import_batch_id`.

**Actividades:** anclaje por `aglead` a `fact_leads`; fechas de actividad/programación parseadas; dimensiones re-resueltas en el sync (redundante pero coherente con el patrón del proyecto).

---

## 2. Trazabilidad

El diseño permite responder, para un lote dado: *¿cuándo entró, cuántas filas raw generó, si ya se promovió a core y en qué estado está el job?*

```
Sell-U → Edge → ingest.import_batches
              → raw.* (import_batch_id)
              → trigger → ingest.pending_sync_jobs
              → process_pending_sync_jobs → core.fact_* (source_import_batch_id)
```

**Calidad de trazabilidad:** **alta** a nivel de modelo. El UUID de lote es el hilo conductor en las tres capas.

**Estado observado (2026-05-20):** ~1.69M filas en `raw.raw_leads` vs ~1.10M en `core.fact_leads`; lotes Sell-U recientes con filas en raw y jobs aún `pending`. Interpretación: el **vínculo diseñado funciona**; el retraso es de **throughput o scheduling de la cola**, no de un esquema roto. Históricamente sí hubo promoción masiva a core.

---

## 3. Duplicidad y convenciones

| Tema | Lectura cualitativa |
|------|---------------------|
| `ingest.import_batches` vs `raw.import_batches` | **Sin ambigüedad en prod:** FKs apuntan a ingest; `raw.import_batches` vacía = residuo del spike, no patrón activo. Riesgo solo en deploys locales si alguien sigue migraciones viejas sin leer config. |
| Texto en raw + UUID en core | **Duplicidad funcional:** staging vs consumo. Calidad del diseño: **aceptable y estándar** en medallion. |
| `raw_payload` + columnas parseadas | **Duplicidad de auditoría:** costo de almacenamiento a cambio de replay y soporte. Apropiado para CRM/APIs cambiantes. |
| Varios lotes Sell-U el mismo día | **Trazabilidad fina** (catch-up manual o reintentos), no duplicidad indebida de negocio si `aglead` se upserta bien en core. |

**Deuda menor:** tablas `public.*` en migraciones del spike (PoC) pueden confundir a quien arranque solo desde el repo sin ver RYD Bases. Conviene tratarlas como **referencia histórica**, no como contrato de producción.

---

## 4. Normalización (1FN–4FN)

La pregunta correcta no es “¿cumple 4FN todo el warehouse?”, sino “¿cumple cada capa **lo que debe cumplir**?”.

| Schema / objeto | 1FN | 2FN | 3FN | 4FN | Adecuación al rol |
|---------------|-----|-----|-----|-----|-------------------|
| **raw** | Cumple* | No | No | No | Correcta para landing |
| **ingest** | Cumple | Cumple | Cumple | Cumple | Correcta para control |
| **core** (`dim_*`) | Cumple | Cumple | Cumple | Cumple | Correcta para entidades |
| **core** (`fact_*`) | Cumple | Parcial | No | N/A | Correcta para estrella |

\* 1FN a nivel de columna; fechas en texto y JSON completo son staging, no modelo final.

**Interpretación:** exigir 3FN estricta en `fact_*` **empeoraría** el diseño analítico. Exigir alta normalización en `raw` **dificultaría** la ingesta. El balance actual es **maduro para un lakehouse ligero en Postgres**.

---

## Conclusiones y seguimiento sugerido

1. **Diseño:** apto para producción; capas bien ubicadas; contrato raw→core claro vía funciones y cola.  
2. **Operación:** monitorear `pending_sync_jobs` tras picos de carga (Sell-U diario + catch-up).  
3. **Documentación:** mantener este doc y [ARCHITECTURE.md](./ARCHITECTURE.md) como par (ingesta vs modelo de datos).  
4. **Spike local:** no usar `raw.import_batches` / `public.leads` como referencia de prod; alinear siempre `INGEST_IMPORT_BATCHES_SCHEMA=ingest`.

---

## Referencias

- [ARCHITECTURE.md](./ARCHITECTURE.md) — pipeline Sell-U, cron diario, cursor  
- Funciones: `process_pending_sync_jobs`, `sync_raw_leads_batch`, `sync_raw_lead_activities_batch`, `enqueue_raw_leads_sync_job`
