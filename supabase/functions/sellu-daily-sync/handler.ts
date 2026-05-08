import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

import { authorize, corsHeaders, requireEnv } from "./env.ts";
import { syncSellu } from "./sync_service.ts";

export async function handleSelluDailySync(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    authorize(req);

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceKey);

    const summary = await syncSellu(supabase);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message === "Unauthorized" ? 401 : 500;
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
}
