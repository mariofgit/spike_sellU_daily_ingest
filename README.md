# spike-sellu-crm-supabase-daily-ingest

Spike enfocado en **trigger del endpoint Sell‑U** (`ReportePowerBI.php` POST) y **persistencia en Supabase** (`raw`/staging según configuración).

- **Edge**: `supabase/functions/sellu-daily-sync/` — capas: `handler` (HTTP), `sync_service`, `sellu_api`, `payload_parse`, `row_mappers`, utilidades (`env`, `calendar`, `types`).
- **Paridad local** (sin Edge): `scripts/ingest-local.mjs` + `scripts/sellu-sync-engine.mjs`.

Variables de entorno: `.env.example`.

## Edge Function + cron diario

1. CLI: `supabase login` y, si hace falta, `supabase link --project-ref <ref>`.
2. Con el mismo `.env`: `npm run deploy:edge:sellu` (o `node --env-file=.env scripts/deploy-sellu-edge.mjs`). La CLI rechaza secretos `SUPABASE_*` personalizados: el script publica equivalentes `INGEST_*` tomados de tus `SUPABASE_*` locales.
3. Define `CRON_SECRET` en `.env` antes de desplegar si no quieres que se regenere en cada corrida (mismo valor en el SQL de cron).
4. Dashboard → Extensions: **pg_cron** y **pg_net**.
5. SQL Editor: `supabase/sql/sellu-daily-sync-pg-cron.sql`; sustituir `__PROJECT_REF__` y `__CRON_SECRET__`; cron en UTC si aplica.
