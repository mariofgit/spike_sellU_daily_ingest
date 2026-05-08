/**
 * Sell-U → Supabase: Edge HTTP entrypoint.
 *
 * Layered layout: `handler.ts` (HTTP), `sync_service.ts` (DB orchestration),
 * `sellu_api.ts` (upstream POST/GET), `payload_parse.ts` / `row_mappers.ts` (mapping).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { handleSelluDailySync } from "./handler.ts";

Deno.serve((req) => handleSelluDailySync(req));
