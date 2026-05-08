export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

export function getEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

export function requireEnv(name: string): string {
  const v = getEnv(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * The platform does not allow user-defined Edge secrets whose names start with `SUPABASE_`.
 * Use `INGEST_*` in production Edge; `SUPABASE_*` still works locally via `--env-file`.
 */
export function getIngestEnv(ingestName: string, legacySupabaseName: string): string | undefined {
  const a = getEnv(ingestName);
  const b = getEnv(legacySupabaseName);
  if (a !== undefined && a.trim() !== "") return a.trim();
  if (b !== undefined && b.trim() !== "") return b.trim();
  return undefined;
}

/** When CRON_SECRET is set on the function, require Bearer or `x-cron-secret` header. */
export function authorize(req: Request): void {
  const cronSecret = getEnv("CRON_SECRET");
  if (!cronSecret) return;

  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : undefined;
  const header = req.headers.get("x-cron-secret");
  const ok = bearer === cronSecret || header === cronSecret;
  if (!ok) throw new Error("Unauthorized");
}
