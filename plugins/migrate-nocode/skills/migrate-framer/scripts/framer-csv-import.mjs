#!/usr/bin/env node
// Normalizes Framer CMS content to the normalized format (migrate-content/references/content-format.md).
// Two inputs:
//   1. CSV files from Framer's official "CMS Export" plugin (Plugins → CMS Export → pick collection → Export).
//      Pass all collections in ONE run so references by slug resolve across files.
//   2. --api-json <file>: a dump written by framer-api-dump.mjs (Framer Server API): typed fields, real item ids,
//      drafts, galleries/arrays and localized values. Preferred when the client can create an API key.
//
// Usage:
//   node framer-csv-import.mjs <file.csv|dir> [more.csv…] [--out content] [--schema csv-schema.json]
//        [--old-routes "blog=/blog/:slug"] [--routes "blog=/articles/:slug"] [--site https://www.example.com]
//   node framer-csv-import.mjs --api-json content/_raw/framer/framer-cms.json [--out content] [--old-routes …]
//
// CSV facts (from the plugin source, framer/plugins → plugins/cms-export/src/csv.ts): header = field display names;
// first column = slug; optional ":draft" column (true/false); image fields add a "<Name>:alt" column; rich text is HTML;
// images are https://framerusercontent.com/images/… URLs; multi-references joined by ","; enum/reference cells hold
// the raw stored value (case id / item id, or names/slugs) — both are accepted; arrays/galleries are NOT exported;
// localized values are NOT exported. Rows with missing cells (plugin skips empty fieldData) are flagged.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, listOpt, parseRoutes, fillRoute, die, slugify, toFieldName, uniqueName, sanitizeHtml, toISODate, toNumber, toBoolean, parseCsv, inferType, isUrlLike, ContentWriter } from "./lib/content-common.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help || (!args._.length && !args.apiJson)) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const outDir = typeof args.out === "string" ? args.out : "content";
const oldRoutes = parseRoutes(args.oldRoutes);
const routes = parseRoutes(args.routes);
const site = typeof args.site === "string" ? args.site.replace(/\/$/, "") : undefined;
const w = new ContentWriter({ outDir, platform: "framer", tool: "framer-csv-import.mjs" });
const isFramerImage = (u) => /framerusercontent\.com\/images\//.test(u);
const isFramerAsset = (u) => /framerusercontent\.com\/(assets|modules)\//.test(u);
const FRAMER_ID = /^[A-Za-z0-9]{9}$/;

function richtext(v, usage) {
  const s = sanitizeHtml(v, { baseUrl: site, onUrl: (u, tag) => tag === "img" && w.asset({ url: u }, { ...usage, inline: true }) });
  for (const [k, n] of Object.entries(s.removed)) if (!["data-*", "class", "style"].includes(k)) w.warn(`rich text sanitizer removed ${k}`, `${usage.collection}/${usage.item} ×${n}`);
  return { html: s.html, raw: v, rawFormat: "framer-html" };
}
function routeItem(col, item, sub = "") {
  item.url = (sub ? `/${sub}` : "") + fillRoute(oldRoutes[col] || `/${col}/:slug`, item);
  if (routes[col] && item.status === "published") w.redirect({ from: item.url, to: (sub ? `/${sub}` : "") + fillRoute(routes[col], item), collection: col, item: item.id, reason: "framer CMS page", confidence: oldRoutes[col] ? "high" : "medium" });
}

// ====================================================================== CSV (CMS Export plugin)
function fromCsv() {
  const schema = typeof args.schema === "string" ? JSON.parse(fs.readFileSync(args.schema, "utf8")) : {};
  const files = args._.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(p, f)) : [p]));
  const used = new Set();
  const groups = files.map((file) => {
    const rows = parseCsv(fs.readFileSync(file, "utf8"), ",");
    const header = rows.shift() || [];
    const label = path.basename(file, path.extname(file));
    const short = rows.filter((r) => r.length !== header.length).length;
    if (short) w.warn("rows whose cell count differs from the header (CMS Export skips empty cells: later columns may be shifted)", `${label}: ${short} row(s)`);
    const records = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
    return { file, label, name: uniqueName(used, slugify(label)), header, records, slugCol: header[0], draftCol: header.find((h) => h === ":draft") };
  });
  for (const g of groups) g.slugs = new Set(g.records.map((r) => r[g.slugCol]).filter(Boolean));
  const stem = (s) => slugify(s).replace(/(ies|es|s)$/, "");
  for (const g of groups) {
    const fnames = new Set();
    const sch = schema[g.label] || schema[g.name] || {};
    g.fields = [];
    const alts = new Set(g.header.filter((h) => h.endsWith(":alt") && g.header.includes(h.slice(0, -4))));
    for (const col of g.header.slice(1)) {
      if (col === g.draftCol || alts.has(col)) continue;
      const values = g.records.map((r) => r[col]).filter((v) => String(v ?? "").trim() !== "");
      const f = { name: uniqueName(fnames, toFieldName(col)), label: col, _col: col, _alt: alts.has(`${col}:alt`) ? `${col}:alt` : null };
      const o = sch[col];
      if (o?.type) Object.assign(f, o, o.to ? { to: groups.find((x) => x.label === o.to || x.name === o.to)?.name || slugify(o.to) } : {});
      else {
        const parts = values.flatMap((v) => (/,/.test(v) && !/[<\s]/.test(v) ? v.split(",") : [v])).map((s) => s.trim()).filter(Boolean);
        let target = null;
        if (parts.length && !values.some((v) => /[<]|https?:/.test(v))) {
          for (const t of groups) { const hit = parts.filter((p) => t.slugs.has(p)).length; const named = stem(col) === stem(t.label); if (hit && hit / parts.length >= (named ? 0.34 : 0.6) && (!target || hit > target.hit)) target = { t, hit }; }
        }
        if (target) { f.type = values.some((v) => /,/.test(v)) ? "multi-reference" : "reference"; f.to = target.t.name; f._bySlug = true; }
        else if (values.length && values.every((v) => isFramerImage(v))) f.type = "image";
        else if (values.length && values.every((v) => isFramerAsset(v))) f.type = "file";
        else {
          let t = inferType(values, col);
          if (t === "text" && values.length && values.every((v) => FRAMER_ID.test(v) || v.split(",").every((x) => FRAMER_ID.test(x)))) w.warn("column looks like references/enums by Framer item id (not resolvable from CSV: use --api-json or --schema)", `${g.label}.${col}`);
          if (t === "text" && values.length >= 4) { const distinct = [...new Set(values)]; if (distinct.length <= 12 && distinct.length <= values.length / 2 && distinct.every((v) => v.length <= 40)) { t = "option"; f.options = distinct.sort().map((v) => ({ value: slugify(v) || v, label: v })); } }
          if (t === "link" && values.some((v) => v.startsWith("/"))) t = "link";
          if (t === "text" && values.length && values.every((v) => /^\/[\w\-/#?=&.]*$/.test(v))) t = "link";
          f.type = t;
        }
        f.inferred = true;
      }
      f.source = { key: col };
      g.fields.push(f);
    }
    if (!g.fields.some((f) => f.type === "text")) w.warn("no text field found for a title", g.label);
  }
  for (const g of groups) {
    const items = [];
    const titleField = g.fields.find((f) => f.type === "text" && /^(title|name|nome|titulo|título)$/i.test(f.label))?.name || g.fields.find((f) => f.type === "text")?.name;
    for (const r of g.records) {
      const slug = r[g.slugCol] || "";
      if (!slug) { w.warn("row without slug skipped", g.label); continue; }
      const id = slug; // CMS Export has no item ids: slug is the stable id
      const draft = g.draftCol ? toBoolean(r[g.draftCol]) === true : false;
      const item = { id, slug, status: draft ? "draft" : "published" };
      const usage = { collection: g.name, item: id };
      const data = {};
      for (const f of g.fields) {
        const v = String(r[f._col] ?? "").trim();
        if (!v) continue;
        const u = { ...usage, field: f.name };
        let out;
        switch (f.type) {
          case "text": out = r[f._col]; break;
          case "number": out = toNumber(v); break;
          case "boolean": out = toBoolean(v); break;
          case "date": out = toISODate(v); break;
          case "color": case "link": out = v; break;
          case "richtext": out = richtext(r[f._col], u); break;
          case "image": { const alt = f._alt ? r[f._alt] : undefined; w.asset({ url: v, alt: alt || undefined }, u); out = alt ? { url: v, alt } : { url: v }; if (f.multiple) out = [out]; break; }
          case "file": w.asset({ url: v }, u); out = { url: v, name: decodeURIComponent(v.split("/").pop().split("?")[0]) }; break;
          case "option": { const o = (f.options || []).find((x) => x.label === v || x.value === v); out = o ? o.value : v; break; }
          case "reference": case "multi-reference": {
            const target = groups.find((x) => x.name === f.to);
            const ids = v.split(",").map((s) => s.trim()).filter(Boolean).filter((s) => { if (target?.slugs.has(s)) return true; w.warn("reference not found in the target CSV", `${g.label}.${f.label}: ${s}`); return false; });
            out = f.type === "reference" ? ids[0] : ids;
            break;
          }
          default: out = v;
        }
        if (out !== null && out !== undefined && !(Array.isArray(out) && !out.length)) data[f.name] = out;
      }
      item.data = data;
      routeItem(g.name, item);
      items.push(item);
    }
    w.addCollection({ collection: g.name, label: g.label, titleField, ref: path.basename(g.file), fields: g.fields.map(({ _col, _alt, _bySlug, ...f }) => f), items });
  }
  w.note("CSV source: item ids are the slugs (CMS Export has no ids). Types are inferred (inferred: true): check them, override with --schema.");
  w.note("CMS Export skips array/gallery fields and localized values: use framer-api-dump.mjs + --api-json when those matter.");
  if (!Object.keys(oldRoutes).length) w.note("Old item URLs assume /<collection-slug>/<item-slug>: pass --old-routes with the real CMS page paths (see the site's sitemap.xml).");
  return files.length;
}

// ====================================================================== Server API dump (framer-api-dump.mjs)
const FTYPE = { boolean: "boolean", color: "color", number: "number", string: "text", formattedText: "richtext", image: "image", file: "file", link: "link", date: "date", enum: "option", collectionReference: "reference", multiCollectionReference: "multi-reference", array: "json" };
function fromApiJson() {
  const dump = JSON.parse(fs.readFileSync(String(args.apiJson), "utf8"));
  const locales = (dump.locales || []).filter((l) => !dump.defaultLocale || l.id !== dump.defaultLocale.id);
  const used = new Set();
  const nameOf = new Map((dump.collections || []).map((c) => [c.id, uniqueName(used, slugify(c.name))]));
  for (const c of dump.collections || []) {
    const col = nameOf.get(c.id);
    const fnames = new Set();
    const mapField = (f, names) => {
      if (["divider", "unsupported"].includes(f.type)) return null;
      let type = FTYPE[f.type];
      if (!type) { w.unknownType(f.type, `${c.name}.${f.name}`); type = "json"; }
      const nf = { name: uniqueName(names, toFieldName(f.name)), label: f.name, type, source: { id: f.id, type: f.type } };
      if (f.required) nf.required = true;
      if (type === "option") { const u = new Set(); nf.options = (f.cases || []).map((cs) => ({ value: uniqueName(u, slugify(cs.name) || cs.id), label: cs.name, sourceId: cs.id })); }
      if (type === "reference" || type === "multi-reference") { nf.to = nameOf.get(f.collectionId) || f.collectionId; if (!nameOf.has(f.collectionId)) w.warn("reference to a collection not in the dump", `${c.name}.${f.name}`); }
      if (f.type === "array") {
        const sub = new Set();
        const kids = (f.fields || []).map((x) => mapField(x, sub)).filter(Boolean);
        if (kids.length === 1 && kids[0].type === "image") Object.assign(nf, { type: "image", multiple: true, _gallery: true });
        else Object.assign(nf, { structure: "repeater", fields: kids });
      }
      return nf;
    };
    const pairs = (c.fields || []).map((f) => [f, mapField(f, fnames)]).filter(([, nf]) => nf);
    const conv = (f, nf, entry, usage, localeId) => {
      if (!entry) return null;
      let v = localeId && entry.valueByLocale?.[localeId] ? entry.valueByLocale[localeId] : null;
      v = v && v.status !== "new" && v.value !== null && v.value !== undefined ? v.value : entry.value;
      if (v === null || v === undefined || v === "") return null;
      switch (f.type) {
        case "string": case "link": return String(v);
        case "number": return toNumber(v);
        case "boolean": return !!v;
        case "date": return toISODate(v);
        case "color": return typeof v === "object" ? v.light || v.dark || null : String(v);
        case "formattedText": return richtext(String(v), usage);
        case "image": { if (!v.url) return null; w.asset({ url: v.url, sourceId: v.id, alt: v.altText || undefined, width: v.resolution?.width, height: v.resolution?.height }, usage); return strip({ url: v.url, alt: v.altText || undefined, assetId: v.id }); }
        case "file": { if (!v.url) return null; w.asset({ url: v.url, sourceId: v.id }, usage); return strip({ url: v.url, name: decodeURIComponent(v.url.split("/").pop().split("?")[0]), assetId: v.id }); }
        case "enum": { const o = nf.options.find((x) => x.sourceId === v || x.label === v); return o ? o.value : String(v); }
        case "collectionReference": return String(v);
        case "multiCollectionReference": return [].concat(v).map(String);
        case "array": {
          const rows = [].concat(v).map((row) => { const o = {}; for (const sf of f.fields || []) { const snf = nf._gallery ? null : nf.fields.find((x) => x.source.id === sf.id); const x = conv(sf, snf || { options: [] }, row.fieldData?.[sf.id], usage, localeId); if (x !== null && x !== undefined) { if (nf._gallery) return x; o[snf.name] = x; } } return nf._gallery ? null : o; });
          return rows.filter((x) => x !== null);
        }
        default: return v;
      }
    };
    const items = [];
    for (const it of c.items || []) {
      for (const loc of [null, ...locales]) {
        const usage = { collection: col, item: it.id };
        const lslug = loc ? it.slugByLocale?.[loc.id] : null;
        const hasLocalized = loc && (lslug?.value || pairs.some(([f]) => { const e = it.fieldData?.[f.id]?.valueByLocale?.[loc.id]; return e && e.status !== "new" && e.value; }));
        if (loc && !hasLocalized) continue;
        const item = { id: it.id, slug: (lslug?.value) || it.slug, ...(locales.length ? { locale: loc ? loc.code : dump.defaultLocale?.code } : {}), status: it.draft ? "draft" : "published" };
        if (it.createdAt) item.createdAt = toISODate(it.createdAt);
        if (it.updatedAt) item.updatedAt = toISODate(it.updatedAt);
        const data = {};
        for (const [f, nf] of pairs) { const v = conv(f, nf, it.fieldData?.[f.id], { ...usage, field: nf.name }, loc?.id); if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) data[nf.name] = v; }
        item.data = data;
        routeItem(col, item, loc ? loc.slug : "");
        items.push(item);
      }
    }
    const strip2 = (f) => { const { _gallery, ...rest } = f; if (rest.fields) rest.fields = rest.fields.map(strip2); return rest; };
    const titleField = pairs.find(([f]) => f.type === "string" && /^(title|name)$/i.test(f.name))?.[1].name || pairs.find(([f]) => f.type === "string")?.[1].name;
    w.addCollection({ collection: col, label: c.name, titleField, ref: c.id, fields: pairs.map(([, nf]) => strip2(nf)), items, sourceExtra: { managedBy: c.managedBy, slugFieldName: c.slugFieldName } });
  }
  if (locales.length) w.note(`Locales: default ${dump.defaultLocale?.code}, others ${locales.map((l) => `${l.code} (/${l.slug})`).join(", ")}; a localized item is emitted only when it has a translated value or slug.`);
  return (dump.collections || []).length;
}
const strip = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k]; return o; };

const n = args.apiJson ? fromApiJson() : fromCsv();
const res = w.write();
console.log(`framer import (${args.apiJson ? "Server API dump" : `${n} CSV file(s)`}) → ${outDir}/`);
console.log(w.summary());
console.log(`  assets: ${res.assets}, redirects: ${res.redirects}, warnings: ${[...w.warnings.values()].reduce((x, y) => x + y.count, 0)} (see ${outDir}/_report.md)`);
