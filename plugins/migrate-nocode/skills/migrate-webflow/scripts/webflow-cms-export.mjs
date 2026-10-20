#!/usr/bin/env node
// Exports Webflow CMS collections through the Data API v2 (https://api.webflow.com/v2) to the normalized format
// (migrate-content/references/content-format.md). Read-only: needs a Site API token with scopes sites:read + cms:read.
//
// Usage:
//   WEBFLOW_API_TOKEN=… node webflow-cms-export.mjs [--site <siteId|shortName>] [--collections blog-posts,authors]
//        [--out content] [--prefer live|staged] [--no-drafts] [--locales en,pt-BR] [--rpm 60]
//        [--routes "blog-posts=/blog/:slug"] [--token-env WEBFLOW_API_TOKEN] [--site-url https://www.example.com]
//   node webflow-cms-export.mjs --from-raw content/_raw/webflow   (re-normalize saved API responses, no network)
//
// Items: staged items (/items, includes drafts and archived) + live items (/items/live). By default the LIVE version
// of published items is exported (--prefer staged takes the latest editor version). Localized sites: one request set
// per locale (cmsLocaleId); locale variants share the item id. Rate limit: --rpm (60 Starter/Basic, 120 CMS/Business),
// 429 responses honour Retry-After. Raw responses are saved under <out>/_raw/webflow/ (they never contain the token).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, listOpt, parseRoutes, fillRoute, die, slugify, toFieldName, uniqueName, sanitizeHtml, toISODate, toNumber, makeClient, ContentWriter, isDirectRun } from "./lib/content-common.mjs";

let API = "https://api.webflow.com/v2"; // --api-base overrides (tests against a local mock)

export const TYPE_MAP = { PlainText: "text", Email: "text", Phone: "text", RichText: "richtext", Image: "image", MultiImage: "image", File: "file", VideoLink: "link", Link: "link", Number: "number", DateTime: "date", Switch: "boolean", Color: "color", Option: "option", Reference: "reference", MultiReference: "multi-reference", User: "text" };

// ------------------------------------------------------------------ fetch (network) → raw dir
async function fetchRaw({ rawDir, token, siteSel, only, localesSel, rpm }) {
  const client = makeClient({ headers: { authorization: `Bearer ${token}` }, minIntervalMs: Math.ceil(60000 / rpm), onRetry: (s, ms) => console.error(`  HTTP ${s}: waiting ${Math.round(ms / 1000)}s (rate limit)`) });
  const save = (name, body) => fs.writeFileSync(path.join(rawDir, name), JSON.stringify(body, null, 1));
  const get = async (route, query = {}) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== "")).toString();
    const r = await client(`${API}${route}${qs ? "?" + qs : ""}`);
    if (r.status === 401) die("Webflow API answered 401: token missing/invalid or expired (the token value is not shown).");
    if (r.status === 403) die(`Webflow API answered 403 for ${route}: the token lacks a scope (needs sites:read and cms:read).`);
    if (!r.ok) die(`Webflow API ${route} → HTTP ${r.status} ${r.json?.code || ""} ${r.json?.message || ""}`.trim());
    return r.json;
  };
  fs.mkdirSync(rawDir, { recursive: true });
  const sites = await get("/sites");
  save("sites.json", sites);
  const list = sites.sites || [];
  let site = siteSel ? list.find((s) => s.id === siteSel || s.shortName === siteSel || s.displayName === siteSel) : list.length === 1 ? list[0] : null;
  if (!site) die(list.length ? `pick a site with --site: ${list.map((s) => `${s.shortName} (${s.id})`).join(", ")}` : "the token sees no sites");
  site = await get(`/sites/${site.id}`);
  save(`site-${site.id}.json`, site);
  const cols = await get(`/sites/${site.id}/collections`);
  save(`collections-${site.id}.json`, cols);
  const locales = localeList(site).filter((l) => !localesSel.length || localesSel.includes(l.tag) || localesSel.includes(l.cmsLocaleId));
  const multi = localeList(site).length > 1;
  let requests = 3;
  for (const c of cols.collections || []) {
    if (only.length && !only.includes(c.slug) && !only.includes(c.id) && !only.includes(c.displayName)) continue;
    save(`collection-${c.id}.json`, await get(`/collections/${c.id}`));
    requests++;
    for (const loc of multi ? locales : [{ cmsLocaleId: undefined, key: "default" }]) {
      for (const kind of ["staged", "live"]) {
        const items = [];
        let offset = 0, total = Infinity;
        while (offset < total) {
          const r = await get(`/collections/${c.id}/items${kind === "live" ? "/live" : ""}`, { limit: 100, offset, cmsLocaleId: loc.cmsLocaleId });
          requests++;
          items.push(...(r.items || []));
          total = r.pagination?.total ?? items.length;
          if (!r.items?.length) break;
          offset += r.items.length;
        }
        save(`items-${c.id}-${loc.key || loc.cmsLocaleId}-${kind}.json`, { items, pagination: { total: items.length } });
      }
    }
    console.log(`  fetched ${c.slug}`);
  }
  fs.writeFileSync(path.join(rawDir, "_meta.json"), JSON.stringify({ siteId: site.id, fetchedAt: new Date().toISOString(), requests }, null, 1));
  return site.id;
}

/** [{ tag, cmsLocaleId, subdirectory, primary, key }] from a site object (handles the `locales.value` doc variant). */
export function localeList(site) {
  const L = site?.locales?.value || site?.locales || {};
  const out = [];
  if (L.primary) out.push({ ...L.primary, primary: true });
  for (const s of L.secondary || []) out.push({ ...s, primary: false });
  return out.filter((l) => l.cmsLocaleId).map((l) => ({ tag: l.tag || l.displayName, cmsLocaleId: l.cmsLocaleId, subdirectory: String(l.subdirectory || "").replace(/^\/|\/$/g, ""), primary: l.primary, key: l.cmsLocaleId }));
}

// ------------------------------------------------------------------ normalize (raw dir → normalized format)
export function normalizeWebflow(rawDir, { w, prefer = "live", includeDrafts = true, routes = {}, siteUrl } = {}) {
  const read = (n) => { const f = path.join(rawDir, n); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
  const meta = read("_meta.json") || {};
  const siteId = meta.siteId || fs.readdirSync(rawDir).find((f) => /^site-.+\.json$/.test(f))?.slice(5, -5);
  const site = read(`site-${siteId}.json`) || {};
  const cols = read(`collections-${siteId}.json`)?.collections || [];
  const locales = localeList(site);
  const multi = locales.length > 1;
  const origin = siteUrl || (site.customDomains?.[0]?.url ? `https://${site.customDomains[0].url}` : site.shortName ? `https://${site.shortName}.webflow.io` : "");
  const used = new Set();
  const details = cols.map((c) => ({ c, d: read(`collection-${c.id}.json`) })).filter((x) => x.d);
  const nameOf = new Map(details.map(({ c }) => [c.id, uniqueName(used, slugify(c.slug || c.displayName))]));
  for (const { c, d } of details) {
    const col = nameOf.get(c.id);
    const fnames = new Set();
    const fields = [];
    const fmap = []; // [webflow field, normalized]
    let titleField;
    for (const f of d.fields || []) {
      if (f.slug === "slug") continue;
      let type = TYPE_MAP[f.type];
      if (!type) { w.unknownType(f.type, `${c.displayName}.${f.displayName}`); type = "json"; }
      const nf = { name: uniqueName(fnames, toFieldName(f.slug || f.displayName)), label: f.displayName, type };
      if (f.isRequired) nf.required = true;
      if (f.type === "MultiImage") nf.multiple = true;
      if (type === "option") { const u = new Set(); nf.options = (f.validations?.options || []).map((o) => ({ value: uniqueName(u, slugify(o.name) || o.id), label: o.name, sourceId: o.id })); }
      if (type === "reference" || type === "multi-reference") {
        const target = f.validations?.collectionId;
        nf.to = nameOf.get(target) || target || "unknown";
        if (!nameOf.has(target)) w.warn("reference to a collection that was not exported", `${c.displayName}.${f.displayName} → ${target}`);
      }
      nf.source = { key: f.slug, type: f.type, id: f.id };
      if (f.slug === "name") titleField = nf.name;
      fields.push(nf);
      fmap.push([f, nf]);
    }
    const items = [];
    for (const loc of multi ? locales : [{ key: "default", primary: true }]) {
      const staged = read(`items-${c.id}-${loc.key}-staged.json`)?.items || [];
      const live = read(`items-${c.id}-${loc.key}-live.json`)?.items || [];
      const liveById = new Map(live.map((i) => [i.id, i]));
      const all = [...staged, ...live.filter((l) => !staged.some((s) => s.id === l.id))];
      for (const s of all) {
        const l = liveById.get(s.id);
        const published = !!l || (!!s.lastPublished && !s.isDraft && !s.isArchived);
        if (!published && !includeDrafts) continue;
        const src = prefer === "live" && l ? l : s;
        const fd = src.fieldData || {};
        const id = s.id;
        const usage = { collection: col, item: id };
        const item = { id, slug: fd.slug || slugify(fd.name) || id };
        if (multi) item.locale = loc.tag;
        item.status = published && !s.isArchived ? "published" : "draft";
        if (s.isArchived) { item.archived = true; item.sourceStatus = "archived"; }
        else if (published && s.isDraft) item.sourceStatus = "published-with-draft-changes";
        else if (!s.lastPublished && !s.isDraft && !l) item.sourceStatus = "queued";
        if (src.lastPublished || s.lastPublished) item.publishedAt = toISODate(src.lastPublished || s.lastPublished);
        if (s.createdOn) item.createdAt = toISODate(s.createdOn);
        if (src.lastUpdated || s.lastUpdated) item.updatedAt = toISODate(src.lastUpdated || s.lastUpdated);
        const sub = loc.subdirectory ? `/${loc.subdirectory}` : "";
        item.url = `${sub}/${c.slug}/${item.slug}`;
        const data = {};
        for (const [f, nf] of fmap) {
          const v = value(f, nf, fd[f.slug], { ...usage, field: nf.name }, w, origin);
          if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) data[nf.name] = v;
        }
        item.data = data;
        items.push(item);
        // :locale in route templates = the old subdirectory (pt-br) when the locale had one, else the tag
        if (routes[col] && item.status === "published") w.redirect({ from: item.url, to: fillRoute(routes[col].includes(":locale") || !sub ? routes[col] : `/:locale${routes[col]}`, { ...item, locale: loc.subdirectory || item.locale }), collection: col, item: id, reason: "webflow collection page", confidence: "high" });
      }
    }
    w.addCollection({ collection: col, label: c.displayName, titleField, ref: c.id, fields, items, sourceExtra: { siteId, slug: c.slug, singularName: d.singularName } });
  }
  if (multi) w.note(`Locales: ${locales.map((l) => `${l.tag}${l.primary ? " (primary)" : ""}${l.subdirectory ? ` /${l.subdirectory}` : ""}`).join(", ")}. Locale variants share the item id.`);
  w.note("Item URLs assume the default Collection page path /<collection-slug>/<item-slug>.");
  return { siteId, collections: details.length };
}

function value(f, nf, v, usage, w, origin) {
  if (v === null || v === undefined || v === "") return null;
  switch (f.type) {
    case "PlainText": case "Email": case "Phone": case "Link": case "VideoLink": case "Color": case "User": return String(v);
    case "Number": return toNumber(v);
    case "Switch": return !!v;
    case "DateTime": return toISODate(v);
    case "RichText": {
      if (/<wf-component\b/.test(v)) w.warn("rich text contains Webflow component instances (<wf-component>, removed)", `${usage.collection}/${usage.item}`);
      if (/data-rt-embed-type/.test(v)) w.warn("rich text contains custom code embeds (sanitized: scripts/iframes from unknown hosts dropped)", `${usage.collection}/${usage.item}`);
      const s = sanitizeHtml(v, { baseUrl: origin || undefined, onUrl: (u, tag) => tag === "img" && w.asset({ url: u }, { ...usage, inline: true }) });
      for (const [k, n] of Object.entries(s.removed)) if (!["id", "data-*", "class", "style"].includes(k)) w.warn(`rich text sanitizer removed ${k}`, `${usage.collection}/${usage.item} ×${n}`);
      return { html: s.html, raw: v, rawFormat: "webflow-html" };
    }
    case "Image": case "MultiImage": case "File": {
      const one = (x) => {
        if (!x) return null;
        const o = typeof x === "string" ? { url: x } : x;
        if (!o.url) return null;
        w.asset({ url: o.url, sourceId: o.fileId, alt: o.alt || undefined, filename: decodeURIComponent(o.url.split("/").pop() || "") }, usage);
        return f.type === "File" ? strip({ url: o.url, name: decodeURIComponent(o.url.split("/").pop() || ""), assetId: o.fileId }) : strip({ url: o.url, alt: o.alt || undefined, assetId: o.fileId });
      };
      return f.type === "MultiImage" ? [].concat(v).map(one).filter(Boolean) : one(v);
    }
    case "Option": { const o = nf.options.find((x) => x.sourceId === v || x.label === v); if (!o) w.warn("option id not in field options", `${usage.collection}.${usage.field}: ${v}`); return o ? o.value : String(v); }
    case "Reference": return String(v);
    case "MultiReference": return [].concat(v).map(String);
    default: return v;
  }
}
const strip = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k]; return o; };

// ------------------------------------------------------------------ main
if (isDirectRun(import.meta.url)) {
  const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
  const args = parseArgs();
  if (args.help) { console.log(HELP); process.exit(0); }
  const outDir = typeof args.out === "string" ? args.out : "content";
  let rawDir = typeof args.fromRaw === "string" ? args.fromRaw : path.join(outDir, "_raw", "webflow");
  if (!args.fromRaw) {
    const tokenEnv = typeof args.tokenEnv === "string" ? args.tokenEnv : "WEBFLOW_API_TOKEN";
    const token = process.env[tokenEnv];
    if (typeof args.apiBase === "string") API = args.apiBase.replace(/\/$/, "");
    if (!token) { console.log(HELP); die(`set ${tokenEnv} (Site settings → Apps & integrations → API access → Generate API token, scopes sites:read + cms:read), or use --from-raw`); }
    await fetchRaw({ rawDir, token, siteSel: typeof args.site === "string" ? args.site : undefined, only: listOpt(args.collections), localesSel: listOpt(args.locales), rpm: Number(args.rpm) || 60 });
  }
  if (!fs.existsSync(rawDir)) die(`raw dir not found: ${rawDir}`);
  const w = new ContentWriter({ outDir, platform: "webflow", tool: "webflow-cms-export.mjs" });
  const r = normalizeWebflow(rawDir, { w, prefer: args.prefer === "staged" ? "staged" : "live", includeDrafts: args.drafts !== false, routes: parseRoutes(args.routes), siteUrl: typeof args.siteUrl === "string" ? args.siteUrl : undefined });
  const res = w.write();
  console.log(`webflow export (site ${r.siteId}, ${r.collections} collections${args.fromRaw ? ", from raw" : ""}) → ${outDir}/`);
  console.log(w.summary());
  console.log(`  assets: ${res.assets}, redirects: ${res.redirects}, warnings: ${[...w.warnings.values()].reduce((n, x) => n + x.count, 0)} (see ${outDir}/_report.md)`);
}
