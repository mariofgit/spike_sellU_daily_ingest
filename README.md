# spike-sellu-crm-supabase-daily-ingest

Spike focused on **calling the Sell‑U endpoint** (`ReportePowerBI.php` POST) and **persisting to Supabase** (`raw`/staging depending on configuration).

**Architecture (stack, layers, pipeline diagram):** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

**Database schemas (raw, ingest, core):** [docs/REVISION_SCHEMAS_RAW_INGEST_CORE.md](docs/REVISION_SCHEMAS_RAW_INGEST_CORE.md)

**RYD-etl Excel ingest (qualitative review):** [docs/REVISION_INGEST_RYD_ETL.md](docs/REVISION_INGEST_RYD_ETL.md)

- **Edge**: `supabase/functions/sellu-daily-sync/` — layered design: `handler` (HTTP), `sync_service`, `sellu_api`, `payload_parse`, `row_mappers`, helpers (`env`, `calendar`, `types`).
- **Local parity** (without Edge): `scripts/ingest-local.mjs` + `scripts/sellu-sync-engine.mjs`.

Environment variables: `.env.example`.

## Edge Function + daily cron

1. CLI: `supabase login` and, if needed, `supabase link --project-ref <ref>`.
2. Same `.env` as local: `npm run deploy:edge:sellu` (or `node --env-file=.env scripts/deploy-sellu-edge.mjs`). The CLI rejects custom `SUPABASE_*` secrets; the script uploads `INGEST_*` equivalents from your local `SUPABASE_*` vars.
3. Set `CRON_SECRET` in `.env` before deploy if you don’t want a new value each run (use the same value in the cron SQL).
4. Dashboard → Extensions: enable **pg_cron** and **pg_net**.
5. SQL Editor: `supabase/sql/sellu-daily-sync-pg-cron.sql`; replace `__PROJECT_REF__` and `__CRON_SECRET__`; cron schedule is UTC unless you adjust it.
