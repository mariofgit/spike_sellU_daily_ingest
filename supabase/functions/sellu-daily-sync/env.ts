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
 * La plataforma no permite secretos Edge definidos por el usuario con prefijo `SUPABASE_`.
 * En producción usa `INGEST_*`; en local sigue valiendo `SUPABASE_*` vía `--env-file`.
 */
export function getIngestEnv(ingestName: string, legacySupabaseName: string): string | undefined {
  const a = getEnv(ingestName);
  const b = getEnv(legacySupabaseName);
  if (a !== undefined && a.trim() !== "") return a.trim();
  if (b !== undefined && b.trim() !== "") return b.trim();
  return undefined;
}

/** Si CRON_SECRET está definido en la función, exige Bearer o cabecera x-cron-secret. */
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
