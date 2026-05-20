# Revisión: ingest RYD-etl

**Alcance:** capa de ingesta del repo **RYD-etl** (Excel → validación → `ingest.*` → `raw.*`).  
**Fecha:** 2026-05-20 · **Tipo:** análisis cualitativo de diseño y sentido operativo.

> Implementación y código: repo hermano [`RYD-etl`](../../RYD-etl/) (este spike cubre solo ingesta Sell-U vía Edge).

## Qué es “ingest” en RYD-etl

Flujo implementado en `etl/validate.py`, `etl/load_raw.py`, `etl/audit.py`, orquestado por `etl/run.py` y `app.py` (Streamlit):

| Paso | Qué hace | Dónde queda registrado |
|------|----------|------------------------|
| 1. Validar | Contrato por hoja (headers, orden, columna clave, umbrales) | `ingest.import_validation_results` |
| 2. Idempotencia | Mismo archivo + hoja ya cargado → skip | `ingest.import_batches` (`checksum`) |
| 3. Abrir lote | Cabecera de importación | `ingest.import_batches` |
| 4. Corrida por hoja | Auditoría de ejecución | `ingest.import_sheet_runs` |
| 5. Cargar raw | Bulk insert con savepoints por chunk | `raw.*` + `import_batch_id` |
| 6. Reconciliar | `rows_loaded` vs conteo real en DB para el lote | metadata en `import_sheet_runs` |

## Veredicto

**Tiene sentido y está bien planteado** para carga manual de Excel: contratos explícitos, no se traga un archivo inválido en silencio, y cada corrida deja rastro en `ingest`. Es un diseño **maduro** para el caso “un operador sube una hoja”.

| Dimensión | Valoración |
|-----------|------------|
| Claridad del flujo | Alta |
| Trazabilidad (lote + hoja + validaciones) | Alta |
| Idempotencia | Alta |
| Adecuación al uso temporal (Streamlit) | Alta |
| Seguridad / auth | Baja (documentada como deuda) |


**Lectura cualitativa:** no indica por sí solo un diseño incorrecto; indica que **cargas reales suelen perder filas puntuales** (datos, tipos, chunks). Conviene revisar `ingest.import_errors` y los `notes` / `metadata.reconciliation` de `import_sheet_runs` si el negocio esperaba cero fallos.

### Leads excluidos a propósito

`BaseLeads1` / `BaseLeads2` no están en `SHEET_CONTRACTS`. El README y `ETL-Overview.md` dejan claro que **leads ya no entran por este pipeline**.

**Coherente** con un ingest Sell-U separado (Edge → `raw`). No es una omisión del modelo `ingest`, es **división de responsabilidades**.

### Streamlit y password compartido

La ingesta operativa pasa por `app.py` con contraseña en secrets (`.env` / Streamlit Cloud). El README advierte que **no es autenticación enterprise**.

**Correcto para un upload temporal**; no debe evaluarse como producto final de seguridad.

### Fortalezas del diseño de ingest

- **Contratos por hoja** (`SHEET_CONTRACTS`): reduce sorpresas cuando el proveedor cambia el Excel.
- **Doble registro:** lote (`import_batches`) + ejecución por hoja (`import_sheet_runs`).
- **Errores estructurados:** `import_errors` con `error_stage` (validación vs procesamiento).
- **Reconciliación post-carga:** detecta divergencia entre filas reportadas y filas visibles en raw para el `batch_id`.
- **Savepoints en bulk insert:** un chunk malo no envenena todo el lote.


## Conclusión

El **ingest de RYD-etl es correcto y tiene sentido** en su rol: controlar y auditar la entrada de Excel a `raw` antes de cualquier transform a `core`. No hay que rediseñar la capa `ingest` por mezclarla con Sell-U.
