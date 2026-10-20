#!/usr/bin/env node
// Normalizes Webflow CMS CSV exports (Designer → CMS panel → collection → Export) when there is no API token.
// Pass every collection's CSV in ONE run so references (exported as slugs) resolve to item ids across files.
//
// Usage:
//   node webflow-csv-import.mjs <file.csv|dir> [more.csv…] [--out content] [--schema csv-schema.json]
//        [--locales "<Locale ID>=en,<Locale ID>=pt-br"] [--old-routes "blog-posts=/blog/:slug"]
//        [--routes "blog-posts=/blog/:slug"]
//
// CSV facts (observed in real exports, Webflow does not publish the spec): first column = the Name field (its display
// name, e.g. "Title"), then Slug, Collection ID, Locale ID, Item ID, Archived, Draft, Created On, Updated On,
// Published On, then custom fields by display name. Dates use JS Date.toString() ("Sun Feb 15 2026 00:22:44 GMT+0000
// (Coordinated Universal Time)"); Option = option NAME; Reference = target SLUG; Multi-reference = slugs joined by "; ";
// Image/File = CDN URL (no alt text); Multi-image = URLs joined by "; "; Rich text = HTML. One locale per export.
// Field types are inferred (marked "inferred": true); override with --schema:
//   { "Blog Posts": { "Author": { "type": "reference", "to": "authors" }, "Kind": { "type": "option" } } }
import fs from "node:fs";
import path from "node:path";
import { parseArgs, listOpt, parseRoutes, fillRoute, die, slugify, toFieldName, uniqueName, sanitizeHtml, toISODate, toNumber, toBoolean, csvObjects, inferType, isUrlLike, ContentWriter } from "./lib/content-common.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help || !args._.length) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const outDir = typeof args.out === "string" ? args.out : "content";
const schema = typeof args.schema === "string" ? JSON.parse(fs.readFileSync(args.schema, "utf8")) : {};
const localeMap = Object.fromEntries(listOpt(args.locales).map((p) => p.split("=").map((s) => s.trim())));
const oldRoutes = parseRoutes(args.oldRoutes);
const routes = parseRoutes(args.routes);
const SYSTEM = ["slug", "collection id", "locale id", "item id", "archived", "draft", "created on", "updated on", "published on"];
const w = new ContentWriter({ outDir, platform: "webflow", tool: "webflow-csv-import.mjs" });

const files = args._.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(p, f)) : [p]));
if (!files.length) die("no CSV files");

// ---------------------------------------------------------------- read all files, group by collection
const groups = new Map(); // key -> { label, ref, files, header, records[] }
for (const file of files) {
  const base = path.basename(file, path.extname(file));
  const m = /^(.*) - (.*) - ([0-9a-f]{24})$/.exec(base);
  const { header, records } = csvObjects(fs.readFileSync(file, "utf8"));
  if (!header.length) { w.warn("empty CSV", file); continue; }
  const colIdCol = header.find((h) => h.toLowerCase() === "collection id");
  const ref = m?.[3] || records.find((r) => r[colIdCol])?.[colIdCol] || base;
  const label = m?.[2] || base;
  const g = groups.get(ref) || { label, ref, files: [], header, records: [] };
  g.files.push(path.basename(file));
  for (const r of records) g.records.push(r);
  if (header.join("|") !== g.header.join("|")) w.warn("CSV files of the same collection have different headers (merged by column name)", g.files.join(", "));
  groups.set(ref, g);
}
const used = new Set();
for (const g of groups.values()) {
  g.name = uniqueName(used, slugify(g.label));
  const H = (n) => g.header.find((h) => h.toLowerCase() === n);
  g.cols = { name: g.header[0] && !SYSTEM.includes(g.header[0].toLowerCase()) ? g.header[0] : g.header.find((h) => h.toLowerCase() === "name"), slug: H("slug"), itemId: H("item id"), locale: H("locale id"), archived: H("archived"), draft: H("draft"), created: H("created on"), updated: H("updated on"), published: H("published on") };
  g.idOf = (r) => (g.cols.itemId && r[g.cols.itemId]) || r[g.cols.slug] || slugify(r[g.cols.name]);
  g.slugToId = new Map(g.records.map((r) => [r[g.cols.slug], g.idOf(r)]));
  if (!g.cols.slug) w.warn("CSV has no Slug column (ids/slugs derived from the name)", g.label);
}
const allLocales = new Set([...groups.values()].flatMap((g) => g.records.map((r) => r[g.cols.locale]).filter(Boolean)));
const multiLocale = allLocales.size > 1;
if (multiLocale) for (const l of allLocales) if (!localeMap[l]) w.warn("Locale ID without a --locales mapping (used as-is)", l);

// ---------------------------------------------------------------- field inference
const splitMulti = (v) => String(v).split(/;\s*/).map((s) => s.trim()).filter(Boolean);
const stem = (s) => slugify(s).replace(/(ies|es|s)$/, "");
/** Target collection whose slugs match most values (>= 60%, or >= 34% when the column is named like the collection). */
function refTarget(values, self, column) {
  const vals = values.flatMap((v) => (/;/.test(v) ? splitMulti(v) : [v.trim()])).filter(Boolean);
  if (!vals.length) return null;
  let best = null;
  for (const g of groups.values()) {
    const hit = vals.filter((v) => g.slugToId.has(v)).length;
    const named = stem(column) === stem(g.label) || stem(column) === stem(g.name);
    if (hit && hit / vals.length >= (named ? 0.34 : 0.6) && (!best || hit > best.hit)) best = { g, hit };
  }
  return best && (best.g !== self || best.hit === vals.length) ? best.g : null;
}

for (const g of groups.values()) {
  const fnames = new Set();
  g.fields = [];
  const sch = schema[g.label] || schema[g.name] || {};
  const custom = g.header.filter((h) => h !== g.cols.name && !SYSTEM.includes(h.toLowerCase()));
  g.fields.push({ name: uniqueName(fnames, "name"), label: g.cols.name, type: "text", required: true, source: { key: g.cols.name, type: "Name" }, _col: g.cols.name });
  for (const col of custom) {
    const values = g.records.map((r) => r[col]).filter((v) => v !== undefined && String(v).trim() !== "");
    const o = sch[col] || {};
    let f = { name: uniqueName(fnames, toFieldName(col)), label: col, _col: col };
    if (o.type) { Object.assign(f, o); if (o.to && !o.to.match(/^[a-z0-9-]+$/)) f.to = groups.get(o.to)?.name || [...groups.values()].find((x) => x.label === o.to)?.name || slugify(o.to); }
    else {
      const target = values.length && !values.some((v) => /<|https?:/.test(v)) ? refTarget(values, g, col) : null;
      if (target) { f.type = values.some((v) => /;/.test(v)) ? "multi-reference" : "reference"; f.to = target.name; }
      else {
        const allUrlsMulti = values.length && values.every((v) => splitMulti(v).every((u) => isUrlLike(u)));
        let t = inferType(values.flatMap((v) => (allUrlsMulti ? splitMulti(v) : [v])), col);
        if (t === "image" && values.some((v) => /;/.test(v))) f.multiple = true;
        if (t === "text") {
          const distinct = [...new Set(values)];
          if (values.length >= 4 && distinct.length <= 12 && distinct.length <= values.length / 2 && distinct.every((v) => v.length <= 40 && !/\n/.test(v))) { t = "option"; f.options = distinct.sort().map((v) => ({ value: slugify(v) || v, label: v })); }
        }
        f.type = t;
      }
      f.inferred = true;
    }
    f.source = { key: col };
    g.fields.push(f);
  }
}

// ---------------------------------------------------------------- items
const toValue = (f, raw, usage) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const v = String(raw);
  switch (f.type) {
    case "text": return v;
    case "number": return toNumber(v);
    case "boolean": return toBoolean(v);
    case "date": return toISODate(v);
    case "color": case "link": return v.trim();
    case "richtext": {
      const s = sanitizeHtml(v, { onUrl: (u, tag) => tag === "img" && w.asset({ url: u }, { ...usage, inline: true }) });
      if (/data-rt-embed-type/.test(v)) w.warn("rich text custom code embed (sanitized)", `${usage.collection}/${usage.item}`);
      return { html: s.html, raw: v, rawFormat: "webflow-html" };
    }
    case "image": case "file": {
      const list = splitMulti(v).filter(isUrlLike).map((u) => { w.asset({ url: u, filename: decodeURIComponent(u.split("/").pop() || "") }, usage); return f.type === "image" ? { url: u } : { url: u, name: decodeURIComponent(u.split("/").pop() || "") }; });
      return f.multiple ? list : list[0] || null;
    }
    case "option": { const o = (f.options || []).find((x) => x.label === v || x.value === v); return o ? o.value : slugify(v) || v; }
    case "reference": case "multi-reference": {
      const target = [...groups.values()].find((x) => x.name === f.to);
      const ids = splitMulti(v).map((s) => { const id = target?.slugToId.get(s); if (!id) w.warn("reference slug not found in the target CSV", `${usage.collection}.${f.name}: ${s} → ${f.to}`); return id || null; }).filter(Boolean);
      return f.type === "reference" ? ids[0] ?? null : ids;
    }
    default: return v;
  }
};

for (const g of groups.values()) {
  const items = [];
  const oldTpl = oldRoutes[g.name] || `/${g.name}/:slug`;
  for (const r of g.records) {
    const id = g.idOf(r);
    const slug = r[g.cols.slug] || slugify(r[g.cols.name]) || id;
    const archived = toBoolean(r[g.cols.archived]) === true;
    const draft = toBoolean(r[g.cols.draft]) === true;
    const published = !archived && !draft && !!(r[g.cols.published] || "").trim();
    const item = { id, slug };
    if (multiLocale && r[g.cols.locale]) item.locale = localeMap[r[g.cols.locale]] || r[g.cols.locale];
    item.status = published ? "published" : "draft";
    if (archived) { item.archived = true; item.sourceStatus = "archived"; }
    else if (!draft && !published) item.sourceStatus = "never-published";
    const pub = toISODate(r[g.cols.published]); if (pub) item.publishedAt = pub;
    const cr = toISODate(r[g.cols.created]); if (cr) item.createdAt = cr;
    const up = toISODate(r[g.cols.updated]); if (up) item.updatedAt = up;
    item.url = fillRoute(oldTpl, item);
    const data = {};
    for (const f of g.fields) { const v = toValue(f, r[f._col], { collection: g.name, item: id, field: f.name }); if (v !== null && !(Array.isArray(v) && !v.length)) data[f.name] = v; }
    item.data = data;
    items.push(item);
    if (routes[g.name] && published) w.redirect({ from: item.url, to: fillRoute(routes[g.name], item), collection: g.name, item: id, reason: "webflow collection page (CSV)", confidence: "medium" });
  }
  const fields = g.fields.map(({ _col, ...f }) => f);
  w.addCollection({ collection: g.name, label: g.label, titleField: "name", ref: g.ref, fields, items, sourceExtra: { files: g.files } });
}
w.note("Types were inferred from CSV values (fields marked inferred: true). Check them; override with --schema.");
w.note("Webflow CSV exports carry no image alt text and only the locale that was active in the Designer.");
if (!Object.keys(oldRoutes).length) w.note("Old item URLs assume /<collection-name-slug>/<item-slug>; pass --old-routes with the real Collection page paths.");
const res = w.write();
console.log(`webflow CSV import (${files.length} file(s)) → ${outDir}/`);
console.log(w.summary());
console.log(`  assets: ${res.assets}, redirects: ${res.redirects}, warnings: ${[...w.warnings.values()].reduce((n, x) => n + x.count, 0)} (see ${outDir}/_report.md)`);
