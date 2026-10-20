#!/usr/bin/env node
// Dumps every Framer CMS collection (fields + items, drafts, arrays, localized values) through the Framer Server API
// (npm package "framer-api", open beta since Feb 2026, Node >= 22) into one JSON file that framer-csv-import.mjs
// normalizes with --api-json. Optional dependency: the script explains how to install it when missing.
//
// Usage:
//   npm i -D framer-api            (in the project, only for this step)
//   FRAMER_API_KEY=… node framer-api-dump.mjs --project "https://framer.com/projects/Site--abc123def456ghi789jk"
//        [--out content/_raw/framer/framer-cms.json] [--key-env FRAMER_API_KEY]
//   node framer-csv-import.mjs --api-json content/_raw/framer/framer-cms.json
//
// The API key (Project → Site Settings → General → API Keys) acts as the user who created it and is bound to one
// project. It is read from the environment and never printed or written.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs, die } from "./lib/content-common.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help || !args.project) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const keyEnv = typeof args.keyEnv === "string" ? args.keyEnv : "FRAMER_API_KEY";
const key = process.env[keyEnv];
if (!key) die(`set ${keyEnv} (Framer project → Site Settings → General → API Keys)`);
const out = typeof args.out === "string" ? args.out : "content/_raw/framer/framer-cms.json";

let api;
try {
  // resolve from the project (cwd) first, then from this script's folder
  const req = createRequire(path.join(process.cwd(), "package.json"));
  api = await import(pathToFileURL(req.resolve("framer-api")).href);
} catch {
  try { api = await import("framer-api"); } catch { die('package "framer-api" not found. Install it in the project: npm i -D framer-api (needs Node >= 22), then rerun. Without an API key, use the CMS Export plugin CSVs instead.'); }
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, plain(o[k])]));
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const fieldOut = (f) => ({ ...pick(f, ["id", "name", "type", "required", "collectionId", "basedOn", "displayTime", "allowedFileTypes"]), ...(f.cases ? { cases: f.cases.map((c) => pick(c, ["id", "name", "nameByLocale"])) } : {}), ...(f.fields ? { fields: f.fields.map(fieldOut) } : {}) });

const framer = await api.connect(String(args.project), key);
try {
  const defaultLocale = framer.getDefaultLocale ? pick(await framer.getDefaultLocale(), ["id", "code", "name", "slug"]) : null;
  const locales = framer.getLocales ? (await framer.getLocales()).map((l) => pick(l, ["id", "code", "name", "slug", "fallbackLocaleId"])) : [];
  const collections = [];
  for (const c of await framer.getCollections()) {
    const fields = (await c.getFields()).map(fieldOut);
    const items = (await c.getItems()).map((it) => pick(it, ["id", "slug", "slugByLocale", "draft", "createdAt", "updatedAt", "fieldData"]));
    collections.push({ ...pick(c, ["id", "name", "slugFieldName", "slugFieldBasedOn", "managedBy"]), fields, items });
    console.log(`  ${c.name}: ${items.length} items, ${fields.length} fields`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), tool: "framer-api-dump.mjs", defaultLocale, locales, collections }, null, 1));
  console.log(`framer API dump: ${collections.length} collections → ${out}`);
} finally {
  await framer.disconnect?.();
}
