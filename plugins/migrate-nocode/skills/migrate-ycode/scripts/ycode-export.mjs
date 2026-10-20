#!/usr/bin/env node
// Exports the CMS collections of a Ycode backup (.ycode) to the normalized content format
// (migrate-content/references/content-format.md): content/<collection>.json, _assets.json, _redirects.json, _report.md.
//
// Usage:
//   node ycode-export.mjs <backup.ycode> [--out content] [--collections "Blog posts,Clientes"]
//        [--prefer published|draft] [--no-drafts] [--site https://www.example.com]
//        [--routes "blog-posts=/blog/:slug"] [--extract-files] [--all-assets] [--password-env NAME]
//
//   --prefer published  (default) export the live version of each item; draft-only items are exported as drafts
//   --prefer draft      export the latest editor version (unpublished edits included); status still says published/draft
//   --site URL          old site origin: makes relative "/a/…" rich-text image URLs absolute, used for item.url
//   --routes            new-site route templates per collection (normalized name) for _redirects.json
//   --extract-files     write the base64 files embedded in the backup to <out>/_files/ (sets asset.localFile)
//   --all-assets        also list library assets no item references (flagged "unused")
//
// Never exports settings, app_settings, webhooks, api_keys, form_submissions, ai_chats or page passwords.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, listOpt, parseRoutes, fillRoute, die, slugify, toFieldName, uniqueName, escapeHtml, escapeAttr, sanitizeHtml, toISODate, toNumber, toBoolean, ContentWriter } from "./lib/content-common.mjs";
import { readBackup, indexBackup, folderPath, dynamicPages } from "./lib/ycode-backup.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 19).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help || !args._[0]) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const file = args._[0];
if (!fs.existsSync(file)) die(`file not found: ${file}`);
const outDir = typeof args.out === "string" ? args.out : "content";
const prefer = args.prefer === "draft" ? "draft" : "published";
const includeDrafts = args.drafts !== false;
const site = typeof args.site === "string" ? args.site.replace(/\/$/, "") : "";
const routes = parseRoutes(args.routes);
const only = listOpt(args.collections).map((s) => s.toLowerCase());
const password = args.passwordEnv ? process.env[args.passwordEnv] : undefined;

let backup;
try { backup = readBackup(file, { password }); } catch (e) { die(e.message); }
const idx = indexBackup(backup, prefer);
const D = idx.D;
const w = new ContentWriter({ outDir, platform: "ycode", tool: "ycode-export.mjs" });

const MIME_EXT = { "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "application/pdf": ".pdf" };
const withExt = (name, mime) => (path.extname(name || "") ? name : `${name || "file"}${MIME_EXT[mime] || ""}`);

// ---------------------------------------------------------------- assets
const extracted = new Map();
function assetRecord(assetId) {
  const a = idx.assets.get(assetId)?.pick;
  if (!a) return null;
  const filename = withExt(a.filename, a.mime_type);
  let localFile;
  if (args.extractFiles || (!a.public_url && a.content)) {
    localFile = extracted.get(a.id);
    if (!localFile) {
      const f = a.storage_path ? idx.fileByPath.get(a.storage_path) : null;
      const data = f ? Buffer.from(f.base64, "base64") : a.content ? Buffer.from(a.content, "utf8") : null;
      if (data) {
        const rel = path.join("_files", a.id, filename.replace(/[^\w.\- ]+/g, "_"));
        fs.mkdirSync(path.join(outDir, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(outDir, rel), data);
        localFile = path.join(outDir, rel);
        extracted.set(a.id, localFile);
      }
    }
  }
  return { url: a.public_url || null, sourceId: a.id, filename, mime: a.mime_type, size: a.file_size || undefined, width: a.width || undefined, height: a.height || undefined, localFile };
}

function assetValue(assetId, usage, kind) {
  const rec = assetRecord(assetId);
  if (!rec) { w.warn("asset id not found in backup", `${usage.collection}/${usage.item}.${usage.field}: ${assetId}`); return null; }
  w.asset(rec, usage);
  if (!rec.url && !rec.localFile) w.warn("asset without URL or embedded file", rec.filename);
  const v = { url: rec.url, assetId: rec.sourceId };
  if (!rec.url && rec.localFile) v.localFile = rec.localFile;
  if (kind === "image") { if (rec.width) v.width = rec.width; if (rec.height) v.height = rec.height; }
  else { v.name = rec.filename; v.mime = rec.mime; if (rec.size) v.size = rec.size; }
  return v;
}

// ---------------------------------------------------------------- links / pages
const pageById = (id) => idx.pages.get(id)?.pick;
const itemPathCache = new Map();
function pageUrl(link) {
  const p = pageById(link?.id);
  if (!p) return null;
  if (p.is_dynamic && link.collection_item_id) return itemPathCache.get(link.collection_item_id) || null;
  const base = folderPath(idx, p.page_folder_id);
  return p.is_index || !p.slug ? base || "/" : `${base}/${p.slug}`;
}
const dynText = (v) => (typeof v === "string" ? v : v?.data?.content ?? v?.content ?? "");

/** richTextLink mark / CMS link value -> href */
function linkHref(attrs = {}) {
  const t = attrs.type || (attrs.href ? "url" : attrs.url ? "url" : null);
  if (attrs.href && !attrs.type) return attrs.href;
  switch (t) {
    case "url": return dynText(attrs.url) || attrs.href || null;
    case "email": { const e = dynText(attrs.email); return e ? `mailto:${e}` : null; }
    case "phone": { const p = dynText(attrs.phone); return p ? `tel:${p.replace(/\s+/g, "")}` : null; }
    case "page": { const u = pageUrl(attrs.page); return u ? u + (attrs.anchor_layer_id ? `#${attrs.anchor_layer_id}` : "") : null; }
    case "asset": return idx.assets.get(attrs.asset?.id)?.pick?.public_url || null;
    case "field": w.warn("rich text link bound to a CMS field (dynamic) — dropped"); return null;
    default: return dynText(attrs.url) || null;
  }
}

// ---------------------------------------------------------------- Tiptap -> HTML
function tiptapToHtml(doc, ctx) {
  const marksOpen = (marks = []) => {
    let open = "", close = "";
    for (const m of marks) {
      let o = "", c = "";
      switch (m.type) {
        case "bold": o = "<strong>"; c = "</strong>"; break;
        case "italic": o = "<em>"; c = "</em>"; break;
        case "underline": o = "<u>"; c = "</u>"; break;
        case "strike": o = "<s>"; c = "</s>"; break;
        case "code": o = "<code>"; c = "</code>"; break;
        case "subscript": o = "<sub>"; c = "</sub>"; break;
        case "superscript": o = "<sup>"; c = "</sup>"; break;
        case "link": case "richTextLink": {
          const href = m.type === "link" ? m.attrs?.href : linkHref(m.attrs);
          if (href) { o = `<a href="${escapeAttr(href)}"${m.attrs?.target === "_blank" ? ' target="_blank"' : ""}>`; c = "</a>"; }
          break;
        }
        case "dynamicStyle": case "textStyle": case "highlight": break;
        default: ctx.warn(`unknown rich text mark "${m.type}"`);
      }
      open += o; close = c + close;
    }
    return [open, close];
  };
  const kids = (n) => (n.content || []).map(node).join("");
  function node(n) {
    if (!n || typeof n !== "object") return "";
    switch (n.type) {
      case "doc": return kids(n);
      case "text": { const [o, c] = marksOpen(n.marks); return o + escapeHtml(n.text || "") + c; }
      case "paragraph": { const k = kids(n); return k ? `<p>${k}</p>` : ""; }
      case "heading": { const l = Math.min(6, Math.max(1, Number(n.attrs?.level) || 2)); return `<h${l}>${kids(n)}</h${l}>`; }
      case "bulletList": return `<ul>${kids(n)}</ul>`;
      case "orderedList": return `<ol${n.attrs?.start > 1 ? ` start="${n.attrs.start}"` : ""}>${kids(n)}</ol>`;
      case "listItem": return `<li>${kids(n)}</li>`;
      case "blockquote": return `<blockquote>${kids(n)}</blockquote>`;
      case "horizontalRule": return "<hr>";
      case "hardBreak": return "<br>";
      case "codeBlock": return `<pre><code${n.attrs?.language ? ` class="language-${escapeAttr(n.attrs.language)}"` : ""}>${escapeHtml((n.content || []).map((c) => c.text || "").join(""))}</code></pre>`;
      case "table": return `<table><tbody>${kids(n)}</tbody></table>`;
      case "tableRow": return `<tr>${kids(n)}</tr>`;
      case "tableHeader": case "tableCell": { const t = n.type === "tableHeader" ? "th" : "td"; const span = (n.attrs?.colspan > 1 ? ` colspan="${n.attrs.colspan}"` : "") + (n.attrs?.rowspan > 1 ? ` rowspan="${n.attrs.rowspan}"` : ""); return `<${t}${span}>${kids(n)}</${t}>`; }
      case "richTextImage": case "image": {
        const a = n.attrs || {};
        let src = a.src || "";
        if (a.assetId) { const v = assetValue(a.assetId, { ...ctx.usage, inline: true }, "image"); if (v?.url) src = v.url; }
        else if (src) w.asset({ url: site && src.startsWith("/") ? site + src : src, alt: a.alt || undefined }, { ...ctx.usage, inline: true });
        if (!src) return "";
        const img = `<img src="${escapeAttr(src)}" alt="${escapeAttr(a.alt || "")}"${a.title ? ` title="${escapeAttr(a.title)}"` : ""}${a.width ? ` width="${escapeAttr(a.width)}"` : ""}${a.height ? ` height="${escapeAttr(a.height)}"` : ""}>`;
        const href = a.link ? linkHref(a.link) : null;
        return `<figure>${href ? `<a href="${escapeAttr(href)}">${img}</a>` : img}</figure>`;
      }
      case "richTextHtmlEmbed": ctx.warn("rich text HTML embed (sanitized; check it)"); return n.attrs?.code || "";
      case "richTextComponent": ctx.warn("rich text embeds a Ycode component (not converted; see raw)"); return "";
      case "dynamicVariable": ctx.warn("rich text dynamic variable (CMS field binding) replaced by its label"); return escapeHtml(n.attrs?.label || "");
      case "layerMention": return escapeHtml(n.attrs?.label || "");
      default: ctx.warn(`unknown rich text node "${n.type}" (children kept)`); return kids(n);
    }
  }
  return node(doc);
}

// ---------------------------------------------------------------- schema
const TYPE_MAP = { text: "text", email: "text", phone: "text", number: "number", boolean: "boolean", date: "date", date_only: "date", color: "color", reference: "reference", multi_reference: "multi-reference", rich_text: "richtext", image: "image", audio: "file", video: "file", document: "file", link: "link", option: "option" };
const SKIP_TYPES = new Set(["status", "count"]);
const SKIP_KEYS = new Set(["id", "status", "slug", "created_at", "updated_at"]);

const allCollections = [...idx.collections.values()].map((e) => ({ ...e.pick, everPublished: !!e.published })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const usedNames = new Set();
const colName = new Map(allCollections.map((c) => [c.id, uniqueName(usedNames, slugify(c.name) || `collection-${c.id.slice(0, 8)}`)]));
const selected = allCollections.filter((c) => !only.length || only.includes(c.name.toLowerCase()) || only.includes(colName.get(c.id)));
if (!selected.length) die(`no collection matched --collections. Available: ${allCollections.map((c) => `"${c.name}"`).join(", ")}`);
const fieldsOf = (cid) => [...idx.fields.values()].map((e) => e.pick).filter((f) => f.collection_id === cid).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const dyn = dynamicPages(idx);
const multiLocale = idx.locales.length > 1;
const defaultCode = idx.defaultLocale?.code;
const trRows = D.translations || [];
const trVersion = trRows.filter((t) => !!t.is_published === (prefer === "published"));
const translations = trVersion.length ? trVersion : trRows;
const trIndex = new Map(translations.filter((t) => t.is_completed !== false && t.content_value).map((t) => [`${t.locale_id}|${t.source_type}:${t.source_id}:${t.content_key}`, t.content_value]));
const tr = (localeId, type, id, key) => trIndex.get(`${localeId}|${type}:${id}:${key}`);

// First pass: item URL paths (needed to resolve page links to CMS items)
const itemsByCollection = new Map();
for (const c of allCollections) {
  const slugField = fieldsOf(c.id).find((f) => f.key === "slug");
  const list = [...idx.items.values()].filter((e) => e.pick.collection_id === c.id).sort((a, b) => String(a.pick.manual_order ?? "").localeCompare(String(b.pick.manual_order ?? ""), undefined, { numeric: true }));
  itemsByCollection.set(c.id, list);
  const page = dyn.get(c.id)?.[0];
  if (!page) continue;
  const sf = page.settings.cms.slug_field_id ? fieldsOf(c.id).find((f) => f.id === page.settings.cms.slug_field_id) || slugField : slugField;
  for (const e of list) {
    const vals = idx.values.get(e.pick.id)?.[e.published && prefer === "published" ? "published" : e.draft ? "draft" : "published"] || new Map();
    const slug = vals.get(sf?.id);
    if (slug) itemPathCache.set(e.pick.id, `${folderPath(idx, page.page_folder_id)}/${slug}`);
  }
}

// ---------------------------------------------------------------- export
for (const c of selected) {
  const name = colName.get(c.id);
  const srcFields = fieldsOf(c.id);
  const names = new Set();
  const fields = [];
  const fmap = []; // [srcField, normField]
  let titleField;
  for (const f of srcFields) {
    if (SKIP_TYPES.has(f.type) || SKIP_KEYS.has(f.key)) continue;
    let type = TYPE_MAP[f.type];
    if (!type) { w.unknownType(f.type, `${c.name}.${f.name}`); type = "json"; }
    const nf = { name: uniqueName(names, f.key ? toFieldName(f.key) : toFieldName(f.name)), label: f.name, type };
    if (f.key === "name") { nf.required = true; titleField = nf.name; }
    if (f.data?.multiple && ["image", "file"].includes(type)) nf.multiple = true;
    if (type === "option") {
      const used = new Set();
      nf.options = (f.data?.options || []).map((o) => ({ value: uniqueName(used, slugify(o.name) || o.id), label: o.name, sourceId: o.id }));
    }
    if (type === "reference" || type === "multi-reference") {
      nf.to = colName.get(f.reference_collection_id) || f.reference_collection_id;
      if (!selected.some((s) => s.id === f.reference_collection_id)) w.warn("reference to a collection not exported (pass it in --collections)", `${c.name}.${f.name} → ${nf.to}`);
    }
    nf.source = { id: f.id, type: f.type, ...(f.key ? { key: f.key } : {}) };
    if (f.hidden) nf.source.hidden = true;
    fields.push(nf);
    fmap.push([f, nf]);
  }
  const slugField = srcFields.find((f) => f.key === "slug");
  const createdField = srcFields.find((f) => f.key === "created_at");
  const updatedField = srcFields.find((f) => f.key === "updated_at");
  const page = dyn.get(c.id)?.[0];
  if ((dyn.get(c.id) || []).length > 1) w.warn("several dynamic pages render this collection; the first one was used for item URLs", c.name);
  const urlTpl = page ? `${folderPath(idx, page.page_folder_id)}/:slug` : null;

  const items = [];
  const slugsSeen = new Map();
  for (const e of itemsByCollection.get(c.id) || []) {
    const isPublished = !!e.published;
    if (!isPublished && !includeDrafts) continue;
    const vals = idx.values.get(e.pick.id) || { published: new Map(), draft: new Map() };
    const ver = prefer === "draft" ? (e.draft ? "draft" : "published") : isPublished ? "published" : "draft";
    const V = vals[ver];
    const id = e.pick.id;
    const usageBase = { collection: name, item: id };
    const ctxWarn = (msg) => w.warn(msg, `${c.name} / ${id}`);
    const convert = (f, nf, raw, localeId) => {
      if (raw === null || raw === undefined || raw === "") return null;
      const usage = { ...usageBase, field: nf.name };
      switch (nf.type) {
        case "text": return String(raw);
        case "number": return toNumber(raw);
        case "boolean": return toBoolean(raw);
        case "date": return f.type === "date_only" ? String(raw).slice(0, 10) : toISODate(raw);
        case "color": return String(raw);
        case "reference": { const m = String(raw).match(/[0-9a-f-]{36}/i); return m ? m[0] : String(raw); }
        case "multi-reference": { try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(String) : [String(a)]; } catch { return String(raw).split(",").map((s) => s.trim()).filter(Boolean); } }
        case "option": { const o = nf.options.find((x) => x.sourceId === raw || x.label === raw); if (!o) w.warn("option value not in field options", `${c.name}.${f.name}: ${raw}`); return o ? o.value : String(raw); }
        case "image": case "file": {
          let ids;
          try { const p = JSON.parse(raw); ids = Array.isArray(p) ? p : [p]; } catch { ids = String(raw).split(",").map((s) => s.trim()).filter(Boolean); }
          const vs = ids.map((aid) => (typeof aid === "string" ? assetValue(aid, usage, nf.type) : null)).filter(Boolean);
          return nf.multiple ? vs : vs[0] || null;
        }
        case "link": {
          let lv; try { lv = JSON.parse(raw); } catch { return String(raw); }
          if (typeof lv === "string") return lv;
          const href = lv.type === "page" ? pageUrl(lv.page) : lv.type === "asset" ? idx.assets.get(lv.asset?.id)?.pick?.public_url : dynText(lv.url);
          return href || null;
        }
        case "richtext": {
          let doc; try { doc = JSON.parse(raw); } catch { doc = null; }
          const html = doc ? tiptapToHtml(doc, { usage, warn: ctxWarn }) : String(raw);
          const s = sanitizeHtml(html, { baseUrl: site || undefined });
          for (const [k, n] of Object.entries(s.removed)) w.warn(`rich text sanitizer removed ${k}`, `${c.name} / ${id} ×${n}`);
          return { html: s.html, raw: doc ?? raw, rawFormat: doc ? "tiptap" : "html" };
        }
        default: { try { return JSON.parse(raw); } catch { return raw; } }
      }
    };
    const data = {};
    for (const [f, nf] of fmap) { const v = convert(f, nf, V.get(f.id)); if (v !== null && v !== undefined) data[nf.name] = v; }
    const slug = V.get(slugField?.id) || slugify(data[titleField]) || id;
    const item = { id, slug, ...(multiLocale ? { locale: defaultCode } : {}), status: isPublished ? "published" : "draft" };
    if (e.pick.is_publishable === false) item.sourceStatus = "not-publishable";
    const createdAt = toISODate(V.get(createdField?.id));
    const updatedAt = toISODate(V.get(updatedField?.id));
    if (isPublished && createdAt) item.publishedAt = createdAt; // Ycode keeps no per-item publish date
    if (createdAt) item.createdAt = createdAt;
    if (updatedAt) item.updatedAt = updatedAt;
    if (urlTpl) item.url = urlTpl.replace(":slug", slug);
    item.data = data;
    const sk = `${item.locale || ""}|${slug}`;
    if (slugsSeen.has(sk)) w.warn("duplicate slug", `${c.name}: ${slug}`);
    slugsSeen.set(sk, id);
    items.push(item);
    if (routes[name] && item.url) w.redirect({ from: item.url, to: fillRoute(routes[name], item), collection: name, item: id, reason: "ycode dynamic page", confidence: "high" });

    // Localized variants (translations table): only text/rich_text/slug are translatable in Ycode.
    if (multiLocale) {
      for (const loc of idx.locales.filter((l) => !l.is_default)) {
        const keyOf = (f) => (f.key ? `field:key:${f.key}` : `field:id:${f.id}`);
        let any = false;
        const ldata = { ...data };
        for (const [f, nf] of fmap) {
          if (!["text", "rich_text"].includes(f.type)) continue;
          const t = tr(loc.id, "cms", id, keyOf(f));
          if (t === undefined) continue;
          any = true;
          const v = convert(f, nf, t, loc.id);
          if (v !== null) ldata[nf.name] = v;
        }
        const lslug = tr(loc.id, "cms", id, "field:key:slug");
        if (!any && !lslug) continue;
        const litem = { ...item, slug: lslug || slug, locale: loc.code, data: ldata };
        if (urlTpl) {
          const fpath = page ? folderPath(idx, page.page_folder_id, (fo) => tr(loc.id, "folder", fo.id, "slug") || fo.slug) : "";
          litem.url = `/${loc.code}${fpath}/${litem.slug}`;
        }
        items.push(litem);
        if (routes[name] && litem.url) w.redirect({ from: litem.url, to: fillRoute(routes[name], litem), collection: name, item: id, reason: "ycode dynamic page (localized)", confidence: "high" });
      }
    }
  }
  w.addCollection({ collection: name, label: c.name, titleField, ref: c.id, fields, items, sourceExtra: c.sorting ? { sorting: { field: fields.find((f) => f.source.id === c.sorting.field)?.name || c.sorting.field, direction: c.sorting.direction } } : undefined });
  if (!c.everPublished) w.warn("collection was never published (all items exported as draft)", c.name);
}

// Library assets nobody references (optional)
if (args.allAssets) for (const e of idx.assets.values()) { const rec = assetRecord(e.pick.id); if (rec) w.asset({ ...rec, unused: true }); }

if (D.translations?.length && !multiLocale) w.note("translations table present but only one locale: ignored");
w.note(`Ycode keeps no per-item publish date: publishedAt = the item's "Created Date".`);
w.note(`Excluded on purpose: settings, app_settings, webhooks, api_keys, form_submissions (${(D.form_submissions || []).length} rows), ai_chats, page passwords.`);
if (!site) w.note("No --site given: relative rich-text image URLs (/a/…) were left relative when no asset id was attached.");
const res = w.write();
console.log(`ycode export → ${outDir}/ (${prefer} versions${includeDrafts ? ", drafts included" : ""})`);
console.log(w.summary());
console.log(`  assets: ${res.assets}, redirects: ${res.redirects}, warnings: ${[...w.warnings.values()].reduce((n, x) => n + x.count, 0)} (see ${outDir}/_report.md)`);
