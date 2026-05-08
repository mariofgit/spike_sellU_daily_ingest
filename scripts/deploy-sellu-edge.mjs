#!/usr/bin/env node
/**
 * Deploy sellu-daily-sync Edge Function + sync production secrets from .env.
 *
 * Prerequisites: Supabase CLI installed and authenticated (`supabase login`).
 * From repo root:
 *
 *   node --env-file=.env scripts/deploy-sellu-edge.mjs
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_FOR_POST_SYNC = [
  "SUPABASE_URL",
  "SELLU_REPORT_POST_URL",
  "SELLU_SECRET_TOKEN_APP",
];

const EDGE_EXTRA_KEYS = [
  "CRON_SECRET",
  "SELLU_AUTH_KEY",
  "SELLU_AUTHORIZATION",
  "SELLU_API_TOKEN",
  "SELLU_BRAND_GROUP",
  "SELLU_SKIP_ACTIVITIES",
  "SELLU_UPSERT_BATCH_SIZE",
  "SELLU_EXTRA_HEADERS_JSON",
  "SELLU_SYNC_STATE_ENABLED",
  "SELLU_SYNC_TIMEZONE",
  "SELLU_SYNC_FIRST_LOCAL_DATE",
  "SELLU_LEGACY_REPORT_START",
  "SELLU_LEGACY_REPORT_END",
  "SELLU_SYNC_ADVANCE_ON_EMPTY",
];

/**
 * `supabase secrets set` rejects user-defined secret names prefixed `SUPABASE_*`
 * (reserved for host-injected vars). Push these as `INGEST_*` instead.
 * Edge + `sellu-sync-engine` read either naming scheme.
 */
const INGEST_DOTENV_PAIR = [
  ["INGEST_DB_SCHEMA", "SUPABASE_DB_SCHEMA"],
  ["INGEST_TABLE_LEADS", "SUPABASE_TABLE_LEADS"],
  ["INGEST_TABLE_LEADS_ACTIVITY", "SUPABASE_TABLE_LEADS_ACTIVITY"],
  ["INGEST_MODEL", "SUPABASE_INGEST_MODEL"],
  ["INGEST_IMPORT_BATCH_ID", "SUPABASE_IMPORT_BATCH_ID"],
  ["INGEST_IMPORT_BATCHES_TABLE", "SUPABASE_IMPORT_BATCHES_TABLE"],
  ["INGEST_IMPORT_BATCHES_SCHEMA", "SUPABASE_IMPORT_BATCHES_SCHEMA"],
  ["INGEST_IMPORT_BATCH_ROW_JSON", "SUPABASE_IMPORT_BATCH_ROW_JSON"],
  ["INGEST_IMPORT_BATCH_ID_COLUMNS", "SUPABASE_IMPORT_BATCH_ID_COLUMNS"],
  ["INGEST_IMPORT_BATCH_ID_COLUMN", "SUPABASE_IMPORT_BATCH_ID_COLUMN"],
  ["INGEST_IMPORT_BATCH_ON_CONFLICT", "SUPABASE_IMPORT_BATCH_ON_CONFLICT"],
  ["INGEST_SYNC_STATE_TABLE", "SUPABASE_SYNC_STATE_TABLE"],
  ["INGEST_SYNC_STATE_ID", "SUPABASE_SYNC_STATE_ID"],
];

function projectRefFromUrl(raw) {
  const u = new URL(raw.trim());
  const host = u.hostname;
  const sub = host.split(".")[0];
  if (!sub || sub.includes("localhost")) {
    throw new Error("SUPABASE_URL does not look like a hosted Supabase project URL");
  }
  return sub;
}

function getenv(name) {
  const v = process.env[name];
  return v !== undefined && String(v).trim() !== "" ? String(v).trim() : undefined;
}

function collectLines() {
  const lines = [];

  /** @type {Record<string,string>} */
  const out = {};
  let cron = getenv("CRON_SECRET");
  if (!cron) {
    cron = crypto.randomBytes(24).toString("hex");
    process.env.CRON_SECRET = cron;
    console.error(
      "[deploy-sellu-edge] Generated new CRON_SECRET; add it to your local .env and use the same value in pg_cron SQL.",
    );
    console.error(`[deploy-sellu-edge] CRON_SECRET=${cron}`);
  }

  for (const k of EDGE_EXTRA_KEYS) {
    const v = getenv(k);
    if (v !== undefined && v !== "") out[k] = v;
  }

  for (const [edgeKey, legacyKey] of INGEST_DOTENV_PAIR) {
    const v = getenv(edgeKey) ?? getenv(legacyKey);
    if (v !== undefined && v !== "") out[edgeKey] = v;
  }

  if (out.SELLU_AUTH_KEY === undefined && getenv("SELLU_AUTHORIZATION") === undefined &&
    getenv("SELLU_API_TOKEN") === undefined) {
    throw new Error(
      "At least one of SELLU_AUTH_KEY, SELLU_AUTHORIZATION, SELLU_API_TOKEN is required for Sell-U POST.",
    );
  }

  for (const k of REQUIRED_FOR_POST_SYNC) {
    if (!getenv(k)) throw new Error(`Missing required env var: ${k}`);
  }

  for (const [k, v] of Object.entries(out)) {
    if (/\r|\n/.test(k) || /\r|\n/.test(v)) continue;
    lines.push(`${k}=${v}`);
  }
  return { lines: lines.sort(), cronSecret: cron, projectRef: projectRefFromUrl(getenv("SUPABASE_URL")) };
}

function execSupabase(args, cwd) {
  execFileSync("supabase", args, { cwd, stdio: "inherit" });
}

async function main() {
  const root = join(__dirname, "..");
  const tmpDir = join(tmpdir(), `edge-deploy-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const envPath = join(tmpDir, "edge-secrets.env");

  try {
    const { lines, cronSecret, projectRef } = collectLines();
    writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");

    console.error(`[deploy-sellu-edge] project_ref=${projectRef}`);
    console.error(
      "[deploy-sellu-edge] supabase secrets set --env-file (Sell-U + INGEST_*; SUPABASE_* from .env mapped for Edge)",
    );
    execSupabase(["secrets", "set", "--env-file", envPath, "--project-ref", projectRef], root);

    console.error("[deploy-sellu-edge] supabase functions deploy sellu-daily-sync");
    execSupabase(["functions", "deploy", "sellu-daily-sync", "--project-ref", projectRef], root);

    const tplPath = join(root, "supabase", "sql", "sellu-daily-sync-pg-cron.sql");
    readFileSync(tplPath, "utf8");
    console.error("");
    console.error(
      "--- Cron (one-time): open Dashboard → SQL, replace __PROJECT_REF__ and __CRON_SECRET__, or edit:",
    );
    console.error(`  ${tplPath}`);
    console.error("");
    console.error("Values:");
    console.error(`  PROJECT_REF=${projectRef}`);
    console.error(`  CRON_SECRET=${cronSecret}`);
    console.error("");
    console.warn(
      "[deploy-sellu-edge] Ensure pg_cron and pg_net extensions are enabled on this project before running the SQL.",
    );
    console.warn(
      `[deploy-sellu-edge] Invoke URL: https://${projectRef}.supabase.co/functions/v1/sellu-daily-sync (verify_jwt=false; protect with CRON_SECRET)`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
