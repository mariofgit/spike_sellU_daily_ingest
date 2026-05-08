import { getEnv, requireEnv } from "./env.ts";
import type { Json } from "./types.ts";

/** HTTP headers for Sell-U report POST. Authorization: key=&lt;token&gt; */
export function selluUpstreamHeaders(): Record<string, string> {
  const authKey = getEnv("SELLU_AUTH_KEY");
  const authFull = getEnv("SELLU_AUTHORIZATION");
  const legacyBearer = getEnv("SELLU_API_TOKEN");
  const extra = getEnv("SELLU_EXTRA_HEADERS_JSON");

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };

  if (authFull) {
    headers.authorization = authFull;
  } else if (authKey) {
    headers.authorization = `key=${authKey}`;
  } else if (legacyBearer) {
    headers.authorization = `Bearer ${legacyBearer}`;
  }

  if (extra) {
    try {
      Object.assign(headers, JSON.parse(extra) as Record<string, string>);
    } catch {
      throw new Error("Invalid SELLU_EXTRA_HEADERS_JSON");
    }
  }

  return headers;
}

export function buildJsnInfo(
  reportType: "leads" | "actividades",
  start: string,
  end: string,
): Json {
  const secret = requireEnv("SELLU_SECRET_TOKEN_APP");
  const brandGroup = getEnv("SELLU_BRAND_GROUP") ?? "MG";

  return {
    infoAuthApp: { sSecretTokenApp: secret },
    infoJSON: {
      AgMarcaGrupo: brandGroup,
      tipoReporte: reportType,
      fechaInicio: start,
      fechaFinal: end,
    },
  };
}

/** POST con body application/x-www-form-urlencoded (contrato Sell-U). */
export async function postSelluReport(
  url: string,
  reportType: "leads" | "actividades",
  window: { start: string; end: string },
): Promise<unknown> {
  const jsnInfo = buildJsnInfo(reportType, window.start, window.end);
  const body = new URLSearchParams();
  body.set("jsnInfo", JSON.stringify(jsnInfo));

  const res = await fetch(url, {
    method: "POST",
    headers: selluUpstreamHeaders(),
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sell-U POST (${reportType}) HTTP ${res.status}: ${text.slice(0, 800)}`,
    );
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return await res.json();
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Sell-U: response is not JSON (${reportType}), first bytes: ${text.slice(0, 200)}`,
    );
  }
}

/** Modo GET opcional (URLs directas de leads/actividades). */
export async function fetchSelluJson(url: string, method: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const authKey = getEnv("SELLU_AUTH_KEY");
  const authFull = getEnv("SELLU_AUTHORIZATION");
  const token = getEnv("SELLU_API_TOKEN");

  if (authFull) headers.authorization = authFull;
  else if (authKey) headers.authorization = `key=${authKey}`;
  else if (token) headers.authorization = `Bearer ${token}`;

  const extra = getEnv("SELLU_EXTRA_HEADERS_JSON");
  if (extra) {
    try {
      Object.assign(headers, JSON.parse(extra) as Record<string, string>);
    } catch {
      throw new Error("Invalid SELLU_EXTRA_HEADERS_JSON");
    }
  }

  const res = await fetch(url, { method, headers });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Sell-U HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  return await res.json();
}