-- =============================================================================
-- Schedule daily HTTP POST to Edge Function sellu-daily-sync (pg_cron + pg_net)
-- =============================================================================
-- Prerequisites (Dashboard → Database → Extensions): enable pg_cron and pg_net.
--
-- Replace before running:
--   __PROJECT_REF__       → e.g. abcdefghijklmnop (first segment of your SUPABASE_URL host)
--   __CRON_SECRET__       → must match CRON_SECRET in Dashboard → Functions → Secrets
--
-- verify_jwt = false in config.toml for this function: authenticate via CRON_SECRET only
-- (`x-cron-secret` or Authorization Bearer); see authorize() in env.ts / handler.ts.
--
-- Cron timezone is typically UTC. Example “daily at 12:05 UTC” (adjust to your TZ):
--   '5 12 * * *'
--
-- To replace an older job with the same name:
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
