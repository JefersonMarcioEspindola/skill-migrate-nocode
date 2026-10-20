#!/usr/bin/env node
// Validates a content/ folder against the normalized format (references/content-format.md): collection shape,
// field types, required values, value shapes per type, references that resolve, unique (id, locale) and slugs per
// locale, ISO dates, _assets.json / _redirects.json consistency. Optionally checks that asset URLs answer (HEAD).
//
// Usage:
//   node content-validate.mjs [content] [--check-assets] [--concurrency 6] [--timeout 10000] [--strict]
//        [--out content/_validation.md]
// Exit code 1 when there are errors (or warnings with --strict). Terminal output is a short summary.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, FIELD_TYPES, FORMAT_VERSION, readCollection, makeClient, mapLimit, decodeEntities } from "./lib/content-common.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help) { console.log(HELP); process.exit(0); }
const dir = args._[0] || "content";
if (!fs.existsSync(dir)) { console.error(`error: folder not found: ${dir}`); process.exit(1); }
const outFile = typeof args.out === "string" ? args.out : path.join(dir, "_validation.md");

const problems = []; // { level, where, msg }
const err = (where, msg) => problems.push({ level: "error", where, msg });
const warn = (where, msg) => problems.push({ level: "warning", where, msg });
const PLATFORMS = new Set(["ycode", "webflow", "framer", "wordpress", "other"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s.length === 10 ? s + "T00:00:00Z" : s));

// ---------------------------------------------------------------- load
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_") && !/\.items-\d+\.json$/.test(f)).sort();
if (!files.length) { console.error(`error: no collection files in ${dir}`); process.exit(1); }
const cols = new Map();
for (const f of files) {
  let c;
  try { c = readCollection(path.join(dir, f)); } catch (e) { err(f, `invalid JSON: ${e.message}`); continue; }
  cols.set(c.collection, { c, file: f });
}
const refs = []; // { where, to, id }
const mediaUrls = new Map(); // url -> where

// ---------------------------------------------------------------- fields
function checkFields(fields, where, depth = 0) {
  if (!Array.isArray(fields)) { err(where, "fields must be an array"); return; }
  const names = new Set();
  for (const f of fields) {
    const w = `${where}.${f?.name ?? "?"}`;
    if (!f || typeof f !== "object") { err(where, "field is not an object"); continue; }
    if (!NAME_RE.test(f.name || "")) err(w, `field name "${f.name}" is not a safe identifier`);
    if (names.has(f.name)) err(w, "duplicate field name");
    names.add(f.name);
    if (!FIELD_TYPES.includes(f.type)) err(w, `unknown type "${f.type}"`);
    if (f.type === "option" && (!Array.isArray(f.options) || f.options.some((o) => typeof o?.value !== "string"))) err(w, "option field needs options[{value,label}]");
    if ((f.type === "reference" || f.type === "multi-reference") && !(typeof f.to === "string" || Array.isArray(f.to))) warn(w, "reference field without `to`: cannot resolve");
    if (f.multiple && !["image", "file", "option"].includes(f.type)) warn(w, "`multiple` only applies to image/file/option");
    if (f.fields) { if (f.type !== "json") warn(w, "sub-fields on a non-json field"); checkFields(f.fields, w, depth + 1); }
    if (f.layouts) for (const l of f.layouts) checkFields(l.fields || [], `${w}{${l.name}}`, depth + 1);
  }
}

// ---------------------------------------------------------------- values
function checkValue(f, v, where) {
  const many = (fn) => (f.multiple ? (Array.isArray(v) ? v.every(fn) : false) : fn(v));
  const media = (x) => x && typeof x === "object" && (typeof x.url === "string" || (x.url == null && typeof x.localFile === "string"));
  switch (f.type) {
    case "text": case "color": if (typeof v !== "string") err(where, `${f.type} must be a string`); break;
    case "number": if (typeof v !== "number" || !Number.isFinite(v)) err(where, "number must be a finite number"); break;
    case "boolean": if (typeof v !== "boolean") err(where, "boolean must be true/false"); break;
    case "date": if (!isIsoDate(v)) err(where, `date is not ISO 8601: ${JSON.stringify(v)}`); break;
    case "richtext":
      if (!v || typeof v !== "object" || typeof v.html !== "string") err(where, "richtext must be {html, raw, rawFormat}");
      else { if (!("raw" in v)) warn(where, "richtext without raw"); if (/<script\b|\son\w+=|javascript:/i.test(v.html)) err(where, "richtext html is not sanitized (script/on*/javascript:)"); for (const m of v.html.matchAll(/<img[^>]+src="([^"]+)"/g)) mediaUrls.set(decodeEntities(m[1]), where); }
      break;
    case "image": case "file":
      if (!many(media)) err(where, `${f.type} must be {url,…}${f.multiple ? "[]" : ""}`);
      else for (const x of [].concat(v)) if (x.url) mediaUrls.set(x.url, where); else if (x.localFile && !fs.existsSync(x.localFile)) err(where, `localFile missing: ${x.localFile}`);
      break;
    case "reference": if (typeof v !== "string") err(where, "reference must be an id string"); else refs.push({ where, to: f.to, id: v }); break;
    case "multi-reference": if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) err(where, "multi-reference must be an array of id strings"); else for (const id of v) refs.push({ where, to: f.to, id }); break;
    case "option": {
      const vals = new Set((f.options || []).map((o) => o.value));
      const list = f.multiple ? v : [v];
      if (f.multiple && !Array.isArray(v)) { err(where, "option (multiple) must be an array"); break; }
      for (const x of list) { if (typeof x !== "string") err(where, "option value must be a string"); else if (vals.size && !vals.has(x)) warn(where, `option value "${x}" not in options`); }
      break;
    }
    case "link": if (!(typeof v === "string" || (v && typeof v === "object" && typeof v.url === "string"))) err(where, "link must be a URL string or {url,label?,newTab?}"); break;
    case "json":
      if (f.fields || f.layouts) {
        const rows = f.structure === "group" ? [v] : Array.isArray(v) ? v : null;
        if (!rows) { err(where, `${f.structure || "json"} value must be ${f.structure === "group" ? "an object" : "an array"}`); break; }
        rows.forEach((row, i) => {
          if (!row || typeof row !== "object") return err(`${where}[${i}]`, "row must be an object");
          const sub = f.layouts ? f.layouts.find((l) => l.name === row.layout)?.fields : f.fields;
          if (f.layouts && !sub) return warn(`${where}[${i}]`, `unknown layout "${row.layout}"`);
          for (const [k, x] of Object.entries(row)) { if (f.layouts && k === "layout") continue; const sf = sub.find((s) => s.name === k); if (!sf) warn(`${where}[${i}].${k}`, "key not declared in sub-fields"); else if (x !== null && x !== undefined) checkValue(sf, x, `${where}[${i}].${k}`); }
        });
      }
      break;
  }
}

// ---------------------------------------------------------------- collections
const summary = [];
for (const [name, { c, file }] of cols) {
  const before = problems.length;
  const W = file;
  if (c.formatVersion !== FORMAT_VERSION) err(W, `formatVersion must be ${FORMAT_VERSION}`);
  if (`${c.collection}.json` !== file) err(W, `collection "${c.collection}" does not match the file name`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.collection || "")) warn(W, "collection name should be lowercase kebab-case");
  if (!c.source || !PLATFORMS.has(c.source.platform)) err(W, "source.platform missing or unknown");
  checkFields(c.fields, name);
  if (!Array.isArray(c.items)) { err(W, "items must be an array"); continue; }
  if (c.titleField && !c.fields.some((f) => f.name === c.titleField)) err(W, `titleField "${c.titleField}" is not a field`);
  const fieldBy = new Map((c.fields || []).map((f) => [f.name, f]));
  const keys = new Set(), slugs = new Map();
  for (const [i, it] of c.items.entries()) {
    const w = `${name}/${it?.id ?? `#${i}`}${it?.locale ? `@${it.locale}` : ""}`;
    if (!it || typeof it !== "object") { err(`${name}#${i}`, "item is not an object"); continue; }
    if (typeof it.id !== "string" || !it.id) err(w, "id must be a non-empty string");
    if (typeof it.slug !== "string" || !it.slug) err(w, "slug must be a non-empty string");
    else if (/[\s/?#]/.test(it.slug)) warn(w, `slug "${it.slug}" has spaces or URL separators`);
    if (!["published", "draft"].includes(it.status)) err(w, `status must be published|draft (got ${JSON.stringify(it.status)})`);
    const k = `${it.id}|${it.locale || ""}`;
    if (keys.has(k)) err(w, "duplicate (id, locale)");
    keys.add(k);
    const sk = `${it.locale || ""}|${it.slug}`;
    if (slugs.has(sk)) err(w, `slug "${it.slug}" also used by ${slugs.get(sk)} in the same locale`);
    slugs.set(sk, it.id);
    for (const d of ["publishedAt", "createdAt", "updatedAt"]) if (it[d] !== undefined && !isIsoDate(it[d])) err(w, `${d} is not ISO 8601`);
    if (it.url !== undefined && !(typeof it.url === "string" && it.url.startsWith("/"))) warn(w, "url should be a path starting with /");
    if (!it.data || typeof it.data !== "object") { err(w, "data must be an object"); continue; }
    for (const [key, v] of Object.entries(it.data)) {
      const f = fieldBy.get(key);
      if (!f) { warn(`${w}.${key}`, "data key not declared in fields"); continue; }
      if (v === null || v === undefined) continue;
      checkValue(f, v, `${w}.${key}`);
    }
    for (const f of c.fields || []) if (f.required) { const v = it.data[f.name]; if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) (it.status === "published" ? err : warn)(`${w}.${f.name}`, "required value missing"); }
  }
  const locales = [...new Set(c.items.map((i) => i.locale).filter(Boolean))];
  if (locales.length && c.items.some((i) => !i.locale)) warn(name, "some items have a locale and others do not");
  summary.push({ name, items: c.items.length, fields: (c.fields || []).length, locales, issues: problems.length - before });
}

// ---------------------------------------------------------------- references
const idsOf = new Map([...cols].map(([n, { c }]) => [n, new Set((c.items || []).map((i) => i.id))]));
let unresolved = 0;
for (const r of refs) {
  const targets = [].concat(r.to || []);
  if (!targets.length) continue;
  const known = targets.filter((t) => idsOf.has(t));
  if (!known.length) { warn(r.where, `reference target collection "${targets.join("|")}" not in this folder`); continue; }
  if (!known.some((t) => idsOf.get(t).has(r.id))) { unresolved++; err(r.where, `unresolved reference ${r.id} → ${known.join("|")}`); }
}

// ---------------------------------------------------------------- assets / redirects
let assets = [];
const af = path.join(dir, "_assets.json");
if (fs.existsSync(af)) {
  try {
    const a = JSON.parse(fs.readFileSync(af, "utf8"));
    if (a.formatVersion !== FORMAT_VERSION || !Array.isArray(a.assets)) err("_assets.json", "needs {formatVersion: 1, assets: []}");
    assets = a.assets || [];
    const seen = new Set();
    for (const x of assets) {
      const w = `_assets.json ${x.url || x.sourceId}`;
      if (!x.url && !x.localFile) err(w, "asset needs url or localFile");
      if (x.url && !/^https?:\/\//i.test(x.url)) warn(w, "asset url is not absolute");
      if (x.url && seen.has(x.url)) err(w, "duplicate asset url");
      seen.add(x.url);
      if (x.localFile && !fs.existsSync(x.localFile)) warn(w, "localFile not found (paths are relative to the project root)");
      if (!Array.isArray(x.usedBy)) err(w, "usedBy must be an array");
    }
    const listed = new Set(assets.map((x) => x.url));
    for (const [u, where] of mediaUrls) if (!listed.has(u) && /^https?:/.test(u)) warn(where, `media URL not listed in _assets.json: ${u}`);
  } catch (e) { err("_assets.json", `invalid JSON: ${e.message}`); }
} else warn(dir, "_assets.json missing");
const rf = path.join(dir, "_redirects.json");
let redirects = [];
if (fs.existsSync(rf)) {
  try {
    redirects = JSON.parse(fs.readFileSync(rf, "utf8")).redirects || [];
    const from = new Map();
    for (const r of redirects) {
      if (typeof r.from !== "string" || !r.from.startsWith("/")) err(`_redirects.json ${r.from}`, "from must be a path starting with /");
      if (typeof r.to !== "string" || !r.to) err(`_redirects.json ${r.from}`, "to missing");
      if (from.has(r.from)) err(`_redirects.json ${r.from}`, "duplicate from");
      from.set(r.from, r.to);
    }
    for (const r of redirects) { let to = r.to, hops = 0; while (from.has(to) && hops < 10) { to = from.get(to); hops++; } if (hops >= 10 || to === r.from) err(`_redirects.json ${r.from}`, "redirect loop"); else if (hops) warn(`_redirects.json ${r.from}`, `redirect chain (${hops + 1} hops) — point it straight to ${to}`); }
  } catch (e) { err("_redirects.json", `invalid JSON: ${e.message}`); }
}

// ---------------------------------------------------------------- optional: assets reachable
let checked = 0, broken = 0;
if (args.checkAssets) {
  const client = makeClient({ retries: 1 });
  const timeout = Number(args.timeout) || 10000;
  const urls = assets.filter((a) => a.url).map((a) => a.url);
  await mapLimit(urls, Number(args.concurrency) || 6, async (u) => {
    const t = new Promise((r) => setTimeout(() => r({ status: 0 }), timeout));
    let res = await Promise.race([client(u, { method: "HEAD", accept: "*/*" }).catch(() => ({ status: 0 })), t]);
    if ([0, 403, 405].includes(res.status)) res = await Promise.race([client(u, { accept: "*/*" }).catch(() => ({ status: 0 })), t]);
    checked++;
    if (!(res.status >= 200 && res.status < 400)) { broken++; err(`asset ${u}`, `not reachable (HTTP ${res.status || "timeout"})`); }
  });
}

// ---------------------------------------------------------------- report
const errors = problems.filter((p) => p.level === "error"), warnings = problems.filter((p) => p.level === "warning");
const md = [`# Content validation`, "", `- Folder: \`${dir}\`  — ${new Date().toISOString()}`, `- Collections: ${summary.length}, items: ${summary.reduce((n, s) => n + s.items, 0)}, references checked: ${refs.length} (unresolved ${unresolved}), assets: ${assets.length}${args.checkAssets ? ` (reachable check: ${checked - broken}/${checked} ok)` : ""}, redirects: ${redirects.length}`, `- **${errors.length} errors, ${warnings.length} warnings**`, "", "| collection | items | fields | locales | issues |", "|---|---|---|---|---|", ...summary.map((s) => `| ${s.name} | ${s.items} | ${s.fields} | ${s.locales.join(", ") || "-"} | ${s.issues} |`), ""];
const group = (list) => { const m = new Map(); for (const p of list) { const g = m.get(p.msg.replace(/"[^"]*"|\d+/g, "…")) || []; g.push(p); m.set(p.msg.replace(/"[^"]*"|\d+/g, "…"), g); } return m; };
for (const [title, list] of [["Errors", errors], ["Warnings", warnings]]) {
  md.push(`## ${title}`, "");
  if (!list.length) md.push("None.", "");
  for (const [, g] of group(list)) { md.push(`- ${g[0].msg} ×${g.length}`); for (const p of g.slice(0, 10)) md.push(`  - ${p.where}${g.length > 1 ? `: ${p.msg}` : ""}`); if (g.length > 10) md.push(`  - … ${g.length - 10} more`); }
  md.push("");
}
fs.writeFileSync(outFile, md.join("\n"));
console.log(`content-validate: ${summary.length} collections, ${summary.reduce((n, s) => n + s.items, 0)} items, ${refs.length} references (${unresolved} unresolved), ${assets.length} assets${args.checkAssets ? ` (${broken} unreachable)` : ""}, ${redirects.length} redirects`);
console.log(`  ${errors.length} errors, ${warnings.length} warnings → ${outFile}`);
for (const p of errors.slice(0, 5)) console.log(`  error ${p.where}: ${p.msg}`);
process.exit(errors.length || (args.strict && warnings.length) ? 1 : 0);
