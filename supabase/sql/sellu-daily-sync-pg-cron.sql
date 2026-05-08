-- =============================================================================
-- Programar llamada diaria a la Edge Function sellu-daily-sync (pg_cron + pg_net)
-- =============================================================================
-- Requisitos (Dashboard → Database → Extensions): pg_cron, pg_net habilitados.
--
-- Antes sustituye:
--   __PROJECT_REF__       → ej. abcdefghijklmnop (primer segmento del host de SUPABASE_URL)
--   __CRON_SECRET__       → igual que secreto CRON_SECRET en Dashboard → Functions → Secrets
--
-- Esta función tiene verify_jwt = false en config.toml: la seguridad viene de CRON_SECRET
-- (cabecera x-cron-secret o Authorization Bearer), ver authorize() en index.ts.
--
-- Zona cron: habitualmente UTC. Ejemplo “cada día 12:05 UTC” (ajusta a tu TZ):
--   '5 12 * * *'
--
-- Para reemplazar un job viejo del mismo nombre:
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sellu-daily-sync-daily';

SELECT cron.schedule(
  'sellu-daily-sync-daily',
  '5 12 * * *',
  $$
  SELECT
    net.http_post(
      url := 'https://__PROJECT_REF__.supabase.co/functions/v1/sellu-daily-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', '__CRON_SECRET__'
      ),
      body := '{}'::jsonb
    )
  $$
);
