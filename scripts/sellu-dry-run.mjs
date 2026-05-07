#!/usr/bin/env node
/**
 * Prueba POST a Sale-U (ReportePowerBI) sin Supabase.
 *
 * Prepara un archivo .env con las variables del spike (véase ../.env.example).
 *
 *   node --env-file=.env scripts/sellu-dry-run.mjs
 *   node --env-file=.env scripts/sellu-dry-run.mjs leads
 *   node --env-file=.env scripts/sellu-dry-run.mjs actividades
 *
 * Opcional: SELLU_DRY_RUN_LOG_BODY=full imprime también el payload completo sin enmascarar.
 */

function getEnv(name) {
  const v = process.env[name];
  return v !== undefined && String(v).trim() !== ""
    ? String(v).trim()
    : undefined;
}

function requireEnv(name) {
  const v = getEnv(name);
  if (!v) throw new Error(`Falta la variable de entorno: ${name}`);
  return v;
}

function buildAuthHeaders(extraJson) {
  const authKey = getEnv("SELLU_AUTH_KEY");
  const authFull = getEnv("SELLU_AUTHORIZATION");
  const legacyBearer = getEnv("SELLU_API_TOKEN");

  /** @type {Record<string,string>} */
  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };

  if (authFull) headers.authorization = authFull;
  else if (authKey) headers.authorization = `key=${authKey}`;
  else if (legacyBearer) headers.authorization = `Bearer ${legacyBearer}`;

  if (extraJson) {
    try {
      Object.assign(headers, JSON.parse(extraJson));
    } catch {
      throw new Error("SELLU_EXTRA_HEADERS_JSON no es JSON válido");
    }
  }
  return headers;
}

function buildJsnInfo(tipoReporte) {
  const marca = getEnv("SELLU_AG_MARCA_GRUPO") ?? "MG";
  return {
    infoAuthApp: { sSecretTokenApp: requireEnv("SELLU_SECRET_TOKEN_APP") },
    infoJSON: {
      AgMarcaGrupo: marca,
      tipoReporte,
      fechaInicio: requireEnv("SELLU_FECHA_INICIO"),
      fechaFinal: requireEnv("SELLU_FECHA_FIN"),
    },
  };
}

function maskPayload(obj, logSecrets) {
  if (logSecrets) return obj;
  const copy = structuredClone(obj);
  if (
    copy?.infoAuthApp &&
    typeof copy.infoAuthApp === "object" &&
    copy.infoAuthApp.sSecretTokenApp
  ) {
    copy.infoAuthApp = {
      ...copy.infoAuthApp,
      sSecretTokenApp: "***",
    };
  }
  return copy;
}

/**
 * @param {string} url
 * @param {"leads" | "actividades"} tipoReporte
 */
async function postReport(url, tipoReporte) {
  const jsnInfo = buildJsnInfo(tipoReporte);
  const body = new URLSearchParams();
  body.set("jsnInfo", JSON.stringify(jsnInfo));

  const logSecrets = getEnv("SELLU_DRY_RUN_LOG_BODY") === "full";
  console.error(
    `\n--- Request ${tipoReporte} ---\nURL: ${url}\njsnInfo (preview):`,
    JSON.stringify(maskPayload(jsnInfo, logSecrets), null, 2),
  );

  const res = await fetch(url, {
    method: "POST",
    headers: buildAuthHeaders(getEnv("SELLU_EXTRA_HEADERS_JSON")),
    body: body.toString(),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: res.status, ok: res.ok, contentType: res.headers.get("content-type"), body: parsed };
}

async function main() {
  const tipoArg = process.argv[2]?.toLowerCase();
  const reportUrl =
    getEnv("SELLU_REPORT_POST_URL") ?? getEnv("SELLU_REPORT_URL");
  if (!reportUrl) {
    throw new Error(
      "Define SELLU_REPORT_POST_URL (o SELLU_REPORT_URL) en el entorno",
    );
  }

  const runLeads = !tipoArg || tipoArg === "leads" || tipoArg === "both";
  const runAct =
    !tipoArg || tipoArg === "actividades" || tipoArg === "both";

  if (
    tipoArg &&
    tipoArg !== "leads" &&
    tipoArg !== "actividades" &&
    tipoArg !== "both"
  ) {
    console.error(
      "Uso: node --env-file=.env scripts/sellu-dry-run.mjs [leads|actividades|both]",
    );
    process.exit(1);
  }

  /** @type {Array<["leads"|"actividades", Awaited<ReturnType<typeof postReport>>]>} */
  const results = [];

  if (runLeads) {
    results.push(["leads", await postReport(reportUrl, "leads")]);
  }
  if (runAct) {
    results.push(["actividades", await postReport(reportUrl, "actividades")]);
  }

  for (const [name, r] of results) {
    console.error(`\n--- Response ${name} ---\nHTTP ${r.status} ${r.ok ? "OK" : "ERROR"}`);
    console.error("Content-Type:", r.contentType ?? "(sin)");
    const out = typeof r.body === "string"
      ? r.body.slice(0, 8000) + (r.body.length > 8000 ? "\n…(truncado)" : "")
      : JSON.stringify(r.body, null, 2);
    console.log(out);
    if (!r.ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
