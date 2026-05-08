/**
 * Spike Sell-U → Supabase: punto de entrada HTTP (Edge Runtime).
 *
 * Diseño en capas: `handler.ts` (HTTP), `sync_service.ts` (orquestación BD),
 * `sellu_api.ts` (upstream POST/GET), `payload_parse.ts` / `row_mappers.ts` (forma de datos).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { handleSelluDailySync } from "./handler.ts";

Deno.serve((req) => handleSelluDailySync(req));
