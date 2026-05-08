#!/usr/bin/env node
/**
 * Sell-U → Supabase full sync via the Edge-equivalent engine.
 * Runs on your workstation with credentials from .env (never commit secrets).
 *
 *   npm install
 *   node --env-file=.env scripts/ingest-local.mjs
 *
 * Optional: SELLU_UPSERT_BATCH_SIZE=300 (default 500)
 * Optional daily cursor: raw.sellu_sync_state when SELLU_SYNC_STATE_ENABLED=true
 */

import { createClient } from "@supabase/supabase-js";
import { makeSyncSellu } from "./sellu-sync-engine.mjs";

const getEnv = (n) => {
  const v = process.env[n];
  return v !== undefined && String(v).trim() !== "" ? String(v).trim() : undefined;
};

const sync = makeSyncSellu(getEnv);

const url = getEnv("SUPABASE_URL");
const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createClient(url, key);

console.error("Starting sync (large datasets take time)...");
const summary = await sync(supabase);
console.log(JSON.stringify(summary, null, 2));
