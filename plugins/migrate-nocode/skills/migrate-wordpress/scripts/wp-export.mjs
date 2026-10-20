#!/usr/bin/env node
// Exports WordPress content to the normalized format (migrate-content/references/content-format.md).
// Sources (pick one): a SQL dump (best: drafts, raw Gutenberg, all meta) or the public REST API (published only).
//
// Usage:
//   node wp-export.mjs --dump db.sql [--types post,page,event] [--out content] [--routes "post=/blog/:slug,page=/:path"]
//        [--site https://old.example.com] [--prefix wp_] [--acf-json theme/acf-json] [--uploads wp-content/uploads]
//        [--no-drafts] [--include-private] [--include-trash] [--include-builder-data] [--meta key1,key2]
//   node wp-export.mjs --url https://example.com [--types posts,pages] [--max-pages 5] [--per-page 100] [--out content]
//   node wp-export.mjs --from-raw content/_raw/wordpress-rest   (replay a previous REST run offline)
//
// Dump: post meta is mapped through ACF field groups (DB or --acf-json) and JetEngine meta boxes; PHP-serialized
// values are decoded; attachment ids become URLs; shortcodes stay raw (listed in _report.md); Gutenberg comments stay
// in richtext.raw; Elementor/other builder data is detected (pageBuilder field) but not converted.
// Route tokens: :slug :id :path :locale :yyyy :mm :dd. Keys: post type / taxonomy / collection name, plus
// "archive" (date archives target, default /blog) and "author".
// Never exported: user emails/passwords, comments, options, ACF password fields, WooCommerce orders.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, listOpt, parseRoutes, fillRoute, die, slugify, toFieldName, uniqueName, sanitizeHtml, findShortcodes, toISODate, toNumber, toBoolean, decodeEntities, stripTags, isUrlLike, ContentWriter } from "./lib/content-common.mjs";
import { maybeUnserialize, stats as unserStats } from "./lib/php-unserialize.mjs";
import { SECRET_FIELD_NAME, homePath, loadDump, metaOf, registeredTypes, registeredTaxonomies, acfGroups, acfLocationTypes, readAcfJsonDir, jetMetaBoxes, jetRelations, attachments, stripSize, multilingual, permalinkFront, oldPostPath, oldTermPath, hierPath, termsOf, wpautop, BUILDERS, INTERNAL_TYPES, OUT_OF_SCOPE_TYPES, SKIP_TAXONOMIES, siteUrl } from "./lib/wp-core.mjs";
import { RestSource } from "./lib/wp-rest.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help || !(args.dump || args.url || args.fromRaw)) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const outDir = typeof args.out === "string" ? args.out : "content";
const routesArg = parseRoutes(args.routes);
const onlyTypes = listOpt(args.types);
const w = new ContentWriter({ outDir, platform: "wordpress", tool: "wp-export.mjs" });
const shortcodeTotals = new Map();
const addShortcodes = (txt, where) => { for (const [n, c] of findShortcodes(txt)) { const e = shortcodeTotals.get(n) || { count: 0, items: new Set() }; e.count += c; if (e.items.size < 5) e.items.add(where); shortcodeTotals.set(n, e); } };
const reportSanitizer = (removed, where) => { for (const [k, n] of Object.entries(removed)) if (k !== "comment") w.warn(`rich text sanitizer removed ${k}`, `${where} ×${n}`); };

function routeFor(keys, item, defaultTpl, ctx = {}) {
  let tpl = keys.map((k) => routesArg[k]).find(Boolean) || defaultTpl;
  if (item.locale && ctx.defaultLang && item.locale !== ctx.defaultLang && !tpl.includes(":locale")) tpl = `/:locale${tpl}`;
  return fillRoute(tpl, item);
}

// ====================================================================== SQL dump
async function exportDump() {
  // pass 1 loads posts/options/terms (onLoaded), pass 2 reads postmeta of the selected types + attachments
  let m;
  {
    const file = String(args.dump);
    if (!fs.existsSync(file)) die(`dump not found: ${file}`);
    if (/\.gz$/i.test(file)) die("gzip'ed dump: decompress it first (gunzip -k file.sql.gz)");
    const holder = {};
    let selected = null;
    const pick = () => {
      if (selected) return selected;
      const found = new Set([...holder.m.posts.values()].map((p) => p.post_type));
      selected = new Set(onlyTypes.length ? onlyTypes.filter((t) => found.has(t)) : [...found].filter((t) => !INTERNAL_TYPES.test(t) && !["attachment", "revision", "nav_menu_item", "custom_css", "customize_changeset", "oembed_cache", "user_request"].includes(t) && !OUT_OF_SCOPE_TYPES.has(t)));
      for (const t of onlyTypes) if (!found.has(t)) w.warn("requested post type not found in dump", t);
      return selected;
    };
    const defaultType = (t) => !INTERNAL_TYPES.test(t) && !["attachment", "revision", "nav_menu_item", "custom_css", "customize_changeset", "oembed_cache", "user_request"].includes(t) && !OUT_OF_SCOPE_TYPES.has(t);
    m = await loadDump(file, {
      prefix: typeof args.prefix === "string" ? args.prefix : undefined,
      keepContent: (t) => t === "wp_block" || (onlyTypes.length ? onlyTypes.includes(t) : defaultType(t)),
      metaFor: (id, type) => (pick().has(type) || type === "nav_menu_item" ? true : type === "attachment" ? "attachment" : false),
      onLoaded: (mm) => (holder.m = mm),
    }).catch((e) => die(e.message));
    holder.m = m;
    m.selected = pick();
  }
  const site = siteUrl(m, typeof args.site === "string" ? args.site : undefined);
  const types = registeredTypes(m);
  const taxDefs = registeredTaxonomies(m);
  const front = permalinkFront(m);
  const ml = multilingual(m, "post");
  const mlT = multilingual(m, "term");
  const multi = ml.languages.length > 1;
  const att = attachments(m, typeof args.site === "string" ? args.site : undefined, typeof args.uploads === "string" ? args.uploads : undefined);
  const acfJson = listOpt(args.acfJson).flatMap(readAcfJsonDir);
  const groups = acfGroups(m, acfJson).filter((g) => g.active);
  const boxes = jetMetaBoxes(m).filter((b) => b.objectType === "post");
  const rels = jetRelations(m);
  const hp = homePath(m, typeof args.site === "string" ? args.site : undefined);
  const ctxUrl = { types, taxonomies: taxDefs, front, langOf: ml.langOf, defaultLang: ml.defaultLang, homePath: hp };
  const selected = [...m.selected];
  const usedCol = new Set();
  const colOfType = new Map(selected.map((t) => [t, uniqueName(usedCol, slugify(t) || t)]));
  const postsOf = (t) => [...m.posts.values()].filter((p) => p.post_type === t);
  const groupId = (id) => String(ml.groupOf.get(String(id)) || id);
  const termGroupId = (id) => String(mlT.groupOf.get(String(id)) || id);
  const usedTax = new Set();
  for (const t of selected) for (const p of postsOf(t)) for (const tt of termsOf(m, p.ID)) if (!SKIP_TAXONOMIES.has(tt.taxonomy)) usedTax.add(tt.taxonomy);
  const colOfTax = new Map([...usedTax].map((x) => [x, uniqueName(usedCol, usedCol.has(slugify(x)) ? `tax-${slugify(x)}` : slugify(x))]));
  const srcOf = new WeakMap(); // normalized field -> source definition (kept out of the JSON)
  const skippedSecretKeys = new Set(); // ACF password fields: never exported, not even listed as unmapped
  const newUrlOfPost = new Map(); // post id -> new path (for menus / redirection plugin)
  const oldToNew = new Map();

  // ---------------------------------------------------------------- value helpers
  const imageValue = (raw, usage) => {
    if (raw === null || raw === undefined || raw === "" || raw === "0" || raw === 0) return null;
    let id = String(raw).trim();
    if (isUrlLike(id)) { const known = att.byUrl.get(stripSize(id)); if (!known) { w.asset({ url: id }, usage); return { url: id }; } id = known; }
    const a = att.byId.get(id);
    if (!a) { w.warn("attachment id not found", `${usage.collection}/${usage.item}.${usage.field}: ${id}`); return null; }
    w.asset({ url: a.url, sourceId: a.id, filename: a.filename, mime: a.mime, size: a.size, width: a.width, height: a.height, alt: a.alt, localFile: a.localFile }, usage);
    const isImg = !a.mime || a.mime.startsWith("image/");
    return isImg ? clean({ url: a.url, alt: a.alt, width: a.width, height: a.height, assetId: a.id }) : clean({ url: a.url, name: a.filename, mime: a.mime, size: a.size, assetId: a.id });
  };
  const fileValue = (raw, usage) => { const v = imageValue(raw, usage); if (!v) return null; return v.name ? v : clean({ url: v.url, name: path.basename(v.url || ""), assetId: v.assetId }); };
  const idList = (raw) => { const v = maybeUnserialize(raw); if (v === null || v === undefined || v === "") return []; if (Array.isArray(v)) return v.map(String).filter(Boolean); if (typeof v === "object") return Object.values(v).map(String); return String(v).split(",").map((s) => s.trim()).filter(Boolean); };
  const refIds = (raw, where) => idList(raw).filter((id) => { if (m.posts.has(id)) return true; w.warn("reference to a post missing from the dump", `${where}: ${id}`); return false; }).map(groupId);
  const richValue = (raw, where, { autop = true } = {}) => {
    if (raw === null || raw === undefined || raw === "") return null;
    const s = sanitizeHtml(autop ? wpautop(raw) : raw, { baseUrl: site || undefined, onUrl: (u, tag) => tag === "img" && w.asset(assetFromUrl(u), { ...where, inline: true }) });
    reportSanitizer(s.removed, `${where.collection}/${where.item}`);
    addShortcodes(raw, `${where.collection}/${where.item}`);
    return { html: s.html, raw, rawFormat: "classic" };
  };
  const assetFromUrl = (u) => { const id = att.byUrl.get(stripSize(u)); const a = id && att.byId.get(id); return a ? { url: u, sourceId: a.id, filename: a.filename, mime: a.mime, alt: a.alt, width: undefined, height: undefined, localFile: a.localFile } : { url: u }; };
  const dateValue = (raw, { timestamp = false, dateOnly = false } = {}) => {
    if (raw === null || raw === undefined || raw === "") return null;
    if (timestamp || /^\d{9,13}$/.test(String(raw))) { const iso = toISODate(Number(raw)); return iso && dateOnly ? iso.slice(0, 10) : iso; }
    const s = String(raw).trim();
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.replace(" ", "T"); // local time, timezone unknown
    return toISODate(s) || s;
  };

  // ---------------------------------------------------------------- ACF
  const typeCollections = (list) => { const arr = [].concat(list || []).filter(Boolean).map((t) => colOfType.get(t) || slugify(t)); return arr.length === 1 ? arr[0] : arr.length ? arr : selected.map((t) => colOfType.get(t)); };
  function acfField(f, used, where) {
    const s = f.settings || {};
    if (f.type === "password" || SECRET_FIELD_NAME.test(f.name || "")) { skippedSecretKeys.add(f.name); w.note(`ACF field "${f.name}" (${where}) looks like a secret and was not exported.`); return null; }
    const base = { name: uniqueName(used, toFieldName(f.name || f.key)), label: f.label || f.name, source: { key: f.name, type: `acf:${f.type}`, id: f.key } };
    if (f.required) base.required = true;
    let out;
    switch (f.type) {
      case "text": case "textarea": case "email": case "time_picker": out = { ...base, type: "text" }; break;
      case "url": case "oembed": out = { ...base, type: "link" }; break;
      case "number": case "range": out = { ...base, type: "number" }; break;
      case "wysiwyg": out = { ...base, type: "richtext" }; break;
      case "image": out = { ...base, type: "image" }; break;
      case "file": out = { ...base, type: "file" }; break;
      case "gallery": out = { ...base, type: "image", multiple: true }; break;
      case "select": case "radio": case "button_group": case "checkbox": {
        const ch = s.choices && typeof s.choices === "object" ? (Array.isArray(s.choices) ? s.choices.map((c) => [c, c]) : Object.entries(s.choices)) : [];
        out = { ...base, type: "option", options: ch.map(([value, label]) => ({ value: String(value), label: String(label) })) };
        if (f.type === "checkbox" || Number(s.multiple)) out.multiple = true;
        break;
      }
      case "true_false": out = { ...base, type: "boolean" }; break;
      case "link": out = { ...base, type: "link" }; break;
      case "post_object": case "page_link": out = { ...base, type: Number(s.multiple) ? "multi-reference" : "reference", to: typeCollections(s.post_type) }; break;
      case "relationship": out = { ...base, type: "multi-reference", to: typeCollections(s.post_type) }; break;
      case "taxonomy": out = { ...base, type: ["radio", "select"].includes(s.field_type) ? "reference" : "multi-reference", to: colOfTax.get(s.taxonomy) || slugify(s.taxonomy || "category") }; if (!colOfTax.has(s.taxonomy)) colOfTax.set(s.taxonomy, out.to); break;
      case "user": out = { ...base, type: Number(s.multiple) ? "multi-reference" : "reference", to: "users" }; break;
      case "date_picker": case "date_time_picker": out = { ...base, type: "date" }; break;
      case "color_picker": out = { ...base, type: "color" }; break;
      case "google_map": out = { ...base, type: "json", structure: "map" }; break;
      case "repeater": { const u = new Set(); out = { ...base, type: "json", structure: "repeater", fields: f.sub_fields.map((x) => acfField(x, u, where)).filter(Boolean) }; break; }
      case "group": { const u = new Set(); out = { ...base, type: "json", structure: "group", fields: f.sub_fields.map((x) => acfField(x, u, where)).filter(Boolean) }; break; }
      case "flexible_content": out = { ...base, type: "json", structure: "flexible", layouts: f.layouts.map((l) => { const u = new Set(["layout"]); return { name: l.name, label: l.label, fields: l.sub_fields.map((x) => acfField(x, u, where)).filter(Boolean) }; }) }; break;
      case "message": case "tab": case "accordion": return null;
      case "clone": w.warn("ACF clone field not expanded (exported raw)", `${where}.${f.name}`); out = { ...base, type: "json" }; break;
      default: w.unknownType(`acf:${f.type}`, `${where}.${f.name}`); out = { ...base, type: "json" };
    }
    srcOf.set(out, f);
    return out;
  }
  function acfValue(field, metaKey, postId, usageBase) {
    const f = srcOf.get(field);
    const raw = metaOf(m, postId, metaKey);
    const usage = { ...usageBase, field: usageBase.field || field.name };
    switch (f.type) {
      case "repeater": {
        const n = toNumber(Array.isArray(maybeUnserialize(raw)) ? maybeUnserialize(raw).length : raw) || 0;
        const rows = [];
        for (let i = 0; i < n; i++) { const row = {}; for (const sf of field.fields) { const v = acfValue(sf, `${metaKey}_${i}_${srcOf.get(sf).name}`, postId, usage); if (v !== null && v !== undefined) row[sf.name] = v; } rows.push(row); }
        return rows.length ? rows : null;
      }
      case "flexible_content": {
        const lay = maybeUnserialize(raw);
        if (!Array.isArray(lay)) return null;
        return lay.map((ln, i) => { const L = field.layouts.find((l) => l.name === ln); const row = { layout: String(ln) }; if (!L) { w.warn("ACF flexible layout not defined", `${usage.collection}/${usage.item}: ${ln}`); return row; } for (const sf of L.fields) { const v = acfValue(sf, `${metaKey}_${i}_${srcOf.get(sf).name}`, postId, usage); if (v !== null && v !== undefined) row[sf.name] = v; } return row; });
      }
      case "group": {
        const o = {};
        for (const sf of field.fields) { const v = acfValue(sf, `${metaKey}_${srcOf.get(sf).name}`, postId, usage); if (v !== null && v !== undefined) o[sf.name] = v; }
        return Object.keys(o).length ? o : null;
      }
      default: return scalar(field, raw, usage, f.settings || {});
    }
  }
  function scalar(field, raw, usage, s = {}) {
    if (raw === null || raw === undefined || raw === "") return null;
    const where = `${usage.collection}/${usage.item}.${usage.field}`;
    switch (field.type) {
      case "text": return String(raw);
      case "number": return toNumber(raw);
      case "boolean": return toBoolean(raw);
      case "color": return String(raw);
      case "date": return dateValue(raw, { timestamp: !!s.is_timestamp, dateOnly: s.type === "date" });
      case "richtext": return richValue(String(raw), usage);
      case "link": { const v = maybeUnserialize(raw); if (v && typeof v === "object") return v.url ? clean({ url: v.url, label: v.title || undefined, newTab: v.target === "_blank" || undefined }) : null; return String(raw); }
      case "image": case "file": {
        if (field.multiple) { const v = maybeUnserialize(raw); const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : String(raw).split(","); return list.map((x) => (x && typeof x === "object" ? x.id || x.url : x)).map((x) => (field.type === "image" ? imageValue(x, usage) : fileValue(x, usage))).filter(Boolean); }
        let v = maybeUnserialize(raw);
        if (v && typeof v === "object") v = v.id || v.url;
        return field.type === "image" ? imageValue(v, usage) : fileValue(v, usage);
      }
      case "option": {
        let v = maybeUnserialize(raw);
        if (field.multiple) {
          if (v && typeof v === "object" && !Array.isArray(v)) v = Object.entries(v).filter(([, on]) => on === true || on === "true" || on === "1").map(([k]) => k).concat(Object.keys(v).every((k) => /^\d+$/.test(k)) ? Object.values(v) : []);
          const list = (Array.isArray(v) ? v : [v]).map(String).filter((x) => x && x !== "false");
          return list.length ? [...new Set(list)] : null;
        }
        return Array.isArray(v) ? String(v[0] ?? "") || null : String(v);
      }
      case "reference": { const ids = field.to === "users" ? idList(raw) : colOfTax && [...colOfTax.values()].includes(field.to) ? idList(raw).map(termGroupId) : refIds(raw, where); return ids[0] ?? null; }
      case "multi-reference": { const ids = field.to === "users" ? idList(raw) : [...colOfTax.values()].includes(field.to) ? idList(raw).map(termGroupId) : refIds(raw, where); return ids.length ? ids : null; }
      case "json": return maybeUnserialize(raw);
      default: return maybeUnserialize(raw);
    }
  }

  // ---------------------------------------------------------------- JetEngine
  function jetField(f, used, where) {
    if ((f.object_type || "field") !== "field") return null;
    if (SECRET_FIELD_NAME.test(f.name || "")) { skippedSecretKeys.add(f.name); w.note(`JetEngine field "${f.name}" (${where}) looks like a secret and was not exported.`); return null; }
    const base = { name: uniqueName(used, toFieldName(f.name)), label: f.title || f.name, source: { key: f.name, type: `jetengine:${f.type}` } };
    if (f.is_required === true || f.is_required === "true") base.required = true;
    const opts = () => [].concat(f.options || []).map((o) => ({ value: String(o.key ?? o.value), label: String(o.value ?? o.key) }));
    let out;
    switch (f.type) {
      case "text": case "textarea": case "iconpicker": case "time": out = { ...base, type: "text" }; break;
      case "wysiwyg": out = { ...base, type: "richtext" }; break;
      case "number": out = { ...base, type: "number" }; break;
      case "colorpicker": out = { ...base, type: "color" }; break;
      case "switcher": out = { ...base, type: "boolean" }; break;
      case "date": case "datetime-local": out = { ...base, type: "date" }; break;
      case "checkbox": out = { ...base, type: "option", multiple: true, options: opts() }; break;
      case "select": case "radio": out = { ...base, type: "option", options: opts(), ...(f.is_multiple === true || f.is_multiple === "true" ? { multiple: true } : {}) }; break;
      case "media": out = { ...base, type: "image" }; break;
      case "gallery": out = { ...base, type: "image", multiple: true }; break;
      case "posts": out = { ...base, type: f.is_multiple === true || f.is_multiple === "true" ? "multi-reference" : "reference", to: typeCollections(f.search_post_type) }; break;
      case "repeater": { const u = new Set(); out = { ...base, type: "json", structure: "repeater", fields: [].concat(f["repeater-fields"] || []).map((x) => jetField({ object_type: "field", ...x }, u, where)).filter(Boolean) }; break; }
      case "html": case "tab": case "accordion": case "endpoint": return null;
      default: w.unknownType(`jetengine:${f.type}`, `${where}.${f.name}`); out = { ...base, type: "json" };
    }
    srcOf.set(out, f);
    return out;
  }
  function jetValue(field, raw, usage) {
    const f = srcOf.get(field);
    if (raw === null || raw === undefined || raw === "") return null;
    switch (f.type) {
      case "repeater": {
        const v = maybeUnserialize(raw);
        const rows = v && typeof v === "object" ? Object.values(v) : [];
        return rows.map((r) => { const o = {}; for (const sf of field.fields) { const x = jetValue(sf, r?.[srcOf.get(sf).name], usage); if (x !== null && x !== undefined) o[sf.name] = x; } return o; });
      }
      case "media": { const v = maybeUnserialize(raw); return imageOrFile(v && typeof v === "object" ? v.id || v.url : v, usage); }
      case "gallery": { const v = maybeUnserialize(raw); const list = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? x.id || x.url : x)) : String(v).split(","); return list.map((x) => imageOrFile(String(x).trim(), usage)).filter(Boolean); }
      case "switcher": return toBoolean(raw);
      case "date": return dateValue(raw, { timestamp: f.is_timestamp === true || f.is_timestamp === "true", dateOnly: true });
      case "datetime-local": return dateValue(raw, { timestamp: f.is_timestamp === true || f.is_timestamp === "true" });
      default: return scalar(field, raw, usage, f);
    }
  }
  const imageOrFile = (v, usage) => imageValue(v, usage);

  // ---------------------------------------------------------------- per post type
  const seoKeys = { seoTitle: ["_yoast_wpseo_title", "rank_math_title", "_seopress_titles_title"], seoDescription: ["_yoast_wpseo_metadesc", "rank_math_description", "_seopress_titles_desc"], seoCanonical: ["_yoast_wpseo_canonical", "rank_math_canonical_url", "_seopress_robots_canonical"], seoImage: ["_yoast_wpseo_opengraph-image", "rank_math_facebook_image", "_seopress_social_fb_img"] };
  const knownMeta = /^(_edit_lock|_edit_last|_thumbnail_id|_wp_page_template|_wp_old_slug|_wp_old_date|_encloseme|_pingme|_wp_trash_meta_.*|_elementor_.*|_yoast_wpseo_.*|rank_math_.*|_seopress_.*|_menu_item_.*|_oembed_.*|_wp_desired_post_slug|_wp_attached_file|_wp_attachment_.*|_fl_builder_.*|_bricks_.*|_et_.*|_wpb_.*|ct_.*|_pingme|_jet_.*|_aioseo_.*|_links_to.*|_wpml_.*|_icl_.*|_pll_.*)$/;
  const extraMeta = listOpt(args.meta).filter((k) => { if (SECRET_FIELD_NAME.test(k)) { w.note(`--meta ${k} refused: looks like a secret.`); return false; } return true; });
  const unmapped = new Map();
  const redirectsSeen = new Set();
  const authorsUsed = new Set();
  const dateArchives = new Set();

  for (const type of selected) {
    const col = colOfType.get(type);
    const reg = types.get(type);
    const list = postsOf(type).filter((p) => {
      if (["auto-draft", "inherit"].includes(p.post_status)) return false;
      if (p.post_status === "trash") return !!args.includeTrash;
      if (p.post_status === "private") return !!args.includePrivate;
      if (p.post_status !== "publish") return args.drafts !== false;
      return true;
    });
    const hierarchical = type === "page" || reg?.hierarchical || list.some((p) => p.post_parent && p.post_parent !== "0");
    list.sort(hierarchical ? (a, b) => Number(a.menu_order) - Number(b.menu_order) || a.post_title.localeCompare(b.post_title) : (a, b) => String(b.post_date).localeCompare(String(a.post_date)));
    const metaFor = (p) => m.meta.get(p.ID) || new Map();
    const used = new Set();
    const fields = [];
    const add = (f) => { if (!f) return null; fields.push(f); return f; };
    const F = {
      title: add({ name: uniqueName(used, "title"), label: "Title", type: "text", required: true, source: { key: "post_title" } }),
      content: add({ name: uniqueName(used, "content"), label: "Content", type: "richtext", source: { key: "post_content" } }),
      excerpt: list.some((p) => p.post_excerpt) ? add({ name: uniqueName(used, "excerpt"), label: "Excerpt", type: "text", source: { key: "post_excerpt" } }) : null,
      featuredImage: list.some((p) => metaFor(p).has("_thumbnail_id")) ? add({ name: uniqueName(used, "featuredImage"), label: "Featured image", type: "image", source: { key: "_thumbnail_id" } }) : null,
      author: list.some((p) => m.users.has(p.post_author)) ? add({ name: uniqueName(used, "author"), label: "Author", type: "reference", to: "users", source: { key: "post_author" } }) : null,
      parent: hierarchical ? add({ name: uniqueName(used, "parent"), label: "Parent", type: "reference", to: col, source: { key: "post_parent" } }) : null,
      menuOrder: list.some((p) => Number(p.menu_order)) ? add({ name: uniqueName(used, "menuOrder"), label: "Menu order", type: "number", source: { key: "menu_order" } }) : null,
      template: list.some((p) => metaFor(p).has("_wp_page_template") && metaOf(m, p.ID, "_wp_page_template") !== "default") ? add({ name: uniqueName(used, "template"), label: "Template", type: "text", source: { key: "_wp_page_template" } }) : null,
      pageBuilder: list.some((p) => BUILDERS.some(([, test]) => test(metaFor(p), p.post_content || ""))) ? add({ name: uniqueName(used, "pageBuilder"), label: "Page builder", type: "text", source: { key: "(detected)" } }) : null,
    };
    for (const [k, keys] of Object.entries(seoKeys)) if (list.some((p) => keys.some((x) => metaFor(p).has(x)))) F[k] = add({ name: uniqueName(used, k), label: k.replace(/^seo/, "SEO "), type: k === "seoImage" ? "image" : "text", source: { key: keys.join("|") } });
    if (list.some((p) => metaFor(p).has("_yoast_wpseo_meta-robots-noindex") || String(metaOf(m, p.ID, "rank_math_robots") || "").includes("noindex"))) F.seoNoindex = add({ name: uniqueName(used, "seoNoindex"), label: "SEO noindex", type: "boolean", source: { key: "_yoast_wpseo_meta-robots-noindex|rank_math_robots" } });
    if (args.includeBuilderData && list.some((p) => metaFor(p).has("_elementor_data"))) F.builderData = add({ name: uniqueName(used, "builderData"), label: "Elementor data", type: "json", structure: "builder", source: { key: "_elementor_data" } });
    // taxonomies
    const taxFields = new Map();
    for (const tx of [...usedTax].filter((tx) => list.some((p) => termsOf(m, p.ID, tx).length))) taxFields.set(tx, add({ name: uniqueName(used, tx === "category" ? "categories" : tx === "post_tag" ? "tags" : toFieldName(tx)), label: tx, type: "multi-reference", to: colOfTax.get(tx), source: { key: `taxonomy:${tx}` } }));
    // ACF groups: by location rule or because posts of this type reference their field keys
    const keysUsed = new Set(list.flatMap((p) => [...metaFor(p)].filter(([k, v]) => k.startsWith("_") && /^field_/.test(v?.[0] || "")).map(([, v]) => v[0])));
    const hasKey = (g) => JSON.stringify(g.fields).match(/"key":"(field_[^"]+)"/g)?.some((k) => keysUsed.has(k.slice(7, -1)));
    const acfFields = [];
    for (const g of groups.filter((g) => acfLocationTypes(g).has(type) || hasKey(g))) for (const f of g.fields) { const nf = acfField(f, used, `${col}`); if (nf) { add(nf); acfFields.push(nf); } }
    // JetEngine meta boxes
    const jetFields = [];
    for (const b of boxes.filter((b) => b.postTypes.includes(type))) for (const f of b.fields) { const nf = jetField(f, used, col); if (nf) { add(nf); jetFields.push(nf); } }
    // JetEngine relations (parent side)
    const relFields = [];
    for (const r of rels.filter((r) => r.parent.kind === "posts" && r.parent.type === type)) {
      const to = colOfType.get(r.child.type);
      if (!to) { w.warn("JetEngine relation child type not exported", `${r.name}: ${r.child.type}`); continue; }
      relFields.push([r, add({ name: uniqueName(used, toFieldName(r.name)), label: r.name, type: r.type === "one_to_one" ? "reference" : "multi-reference", to, source: { key: `jet_relation:${r.id}`, type: `jetengine-relation:${r.type}` } })]);
    }
    const extraFields = extraMeta.filter((k) => list.some((p) => metaFor(p).has(k))).map((k) => add({ name: uniqueName(used, toFieldName(k)), label: k, type: list.some((p) => typeof maybeUnserialize(metaOf(m, p.ID, k)) === "object") ? "json" : "text", source: { key: k } }));
    const mappedKeys = new Set([...acfFields.flatMap((f) => [f.source.key, `_${f.source.key}`]), ...jetFields.map((f) => f.source.key), ...extraMeta]);
    const acfPrefixes = acfFields.filter((f) => f.type === "json").map((f) => f.source.key + "_");

    const items = [];
    for (const p of list) {
      const meta = metaFor(p);
      const lang = multi ? ml.langOf.get(p.ID) : undefined;
      const id = multi ? groupId(p.ID) : String(p.ID);
      const usage = { collection: col, item: id };
      let slug = p.post_name ? safeDecode(p.post_name) : "";
      if (!slug) slug = slugify(p.post_title) || `${type}-${p.ID}`;
      const status = p.post_status === "publish" ? "published" : "draft";
      const item = { id, ...(id !== String(p.ID) ? { sourceId: String(p.ID) } : {}), slug, ...(lang ? { locale: lang } : {}), status };
      if (!["publish", "draft"].includes(p.post_status)) item.sourceStatus = p.post_status;
      if (p.post_status === "trash") item.archived = true;
      const pub = p.post_date_gmt && !/^0000/.test(p.post_date_gmt) ? toISODate(p.post_date_gmt) : p.post_date && !/^0000/.test(p.post_date) ? p.post_date.replace(" ", "T") : null;
      if (pub && ["publish", "future", "private"].includes(p.post_status)) item.publishedAt = pub;
      if (pub) item.createdAt = pub;
      const upd = p.post_modified_gmt && !/^0000/.test(p.post_modified_gmt) ? toISODate(p.post_modified_gmt) : null;
      if (upd) item.updatedAt = upd;
      const oldPath = oldPostPath(m, p, ctxUrl);
      if (oldPath) item.url = oldPath;
      const data = {};
      data[F.title.name] = decodeEntities(p.post_title || "");
      // content
      const raw = p.post_content || "";
      if (raw) {
        const isBlocks = /<!--\s*wp:/.test(raw);
        let html = raw.replace(/<!--\s*wp:block\s+(\{[^}]*\})\s*\/-->/g, (m0, j) => { try { const b = m.posts.get(String(JSON.parse(j).ref)); if (b?.post_content) return b.post_content; } catch {} w.warn("reusable block not found", `${col}/${id}`); return ""; });
        html = html.replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, (m0, inner) => { const img = /<img[^>]*>/i.exec(inner)?.[0] || ""; const a = /<a[^>]*>\s*<img[\s\S]*?<\/a>/i.exec(inner)?.[0]; const cap = inner.replace(a || img, "").trim(); return `<figure>${a || img}${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`; });
        html = html.replace(/\[embed\]([\s\S]*?)\[\/embed\]/g, (m0, u) => `<p><a href="${u.trim()}">${u.trim()}</a></p>`);
        if (!isBlocks) html = wpautop(html);
        if (/<!--\s*wp:block\s/.test(raw)) w.warn("reusable blocks inlined into html", `${col}/${id}`);
        const s = sanitizeHtml(html, { baseUrl: site || undefined, onUrl: (u, tag) => tag === "img" && w.asset(assetFromUrl(u), { ...usage, field: F.content.name, inline: true }) });
        reportSanitizer(s.removed, `${col}/${id}`);
        addShortcodes(raw, `${col}/${id}`);
        data[F.content.name] = { html: s.html, raw, rawFormat: isBlocks ? "gutenberg" : "classic" };
      }
      if (F.excerpt && p.post_excerpt) data[F.excerpt.name] = decodeEntities(p.post_excerpt);
      if (F.featuredImage) { const v = imageValue(metaOf(m, p.ID, "_thumbnail_id"), { ...usage, field: F.featuredImage.name }); if (v) data[F.featuredImage.name] = v; }
      if (F.author && m.users.has(p.post_author)) { data[F.author.name] = String(p.post_author); authorsUsed.add(p.post_author); }
      if (F.parent && p.post_parent && p.post_parent !== "0") data[F.parent.name] = groupId(p.post_parent);
      if (F.menuOrder && Number(p.menu_order)) data[F.menuOrder.name] = Number(p.menu_order);
      if (F.template) { const t = metaOf(m, p.ID, "_wp_page_template"); if (t && t !== "default") data[F.template.name] = t; }
      if (F.pageBuilder) { const b = BUILDERS.find(([, test]) => test(meta, raw)); if (b) { data[F.pageBuilder.name] = b[0]; w.warn(`${b[0]} page builder content (not converted: rebuild as components)`, `${col}/${id} ${item.url || ""}`); } }
      for (const k of Object.keys(seoKeys)) if (F[k]) { const v = seoKeys[k].map((x) => metaOf(m, p.ID, x)).find((x) => x); if (v) { if (k === "seoImage") { const iv = imageValue(v, { ...usage, field: F[k].name }); if (iv) data[F[k].name] = iv; } else { data[F[k].name] = v; if (/%%\w+%%|%\w+%/.test(v)) w.warn("SEO template variables left raw (%%title%% …)", `${col}/${id}`); } } }
      if (F.seoNoindex) { const y = metaOf(m, p.ID, "_yoast_wpseo_meta-robots-noindex"); const r = String(metaOf(m, p.ID, "rank_math_robots") || ""); if (y === "1" || r.includes("noindex")) data[F.seoNoindex.name] = true; }
      if (F.builderData) { const j = metaOf(m, p.ID, "_elementor_data"); if (j) { try { data[F.builderData.name] = JSON.parse(j); } catch { data[F.builderData.name] = j; } } }
      for (const [tx, f] of taxFields) { const ts = termsOf(m, p.ID, tx).map((t) => termGroupId(t.term_id)); if (ts.length) data[f.name] = [...new Set(ts)]; }
      for (const f of acfFields) { const v = acfValue(f, f.source.key, p.ID, { ...usage, field: f.name }); if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) data[f.name] = v; }
      for (const f of jetFields) { const v = jetValue(f, metaOf(m, p.ID, f.source.key), { ...usage, field: f.name }); if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) data[f.name] = v; }
      for (const [r, f] of relFields) { const kids = r.rows.filter((x) => String(x.parent_object_id) === p.ID).map((x) => groupId(x.child_object_id)); if (kids.length) data[f.name] = f.type === "reference" ? kids[0] : kids; }
      for (const f of extraFields) { const v = metaOf(m, p.ID, f.source.key); if (v !== undefined && v !== "") data[f.name] = f.type === "json" ? maybeUnserialize(v) : String(v); }
      for (const [k] of meta) if (!knownMeta.test(k) && !mappedKeys.has(k) && !skippedSecretKeys.has(k.replace(/^_/, "")) && !acfPrefixes.some((pre) => k.startsWith(pre) || k.startsWith("_" + pre)) && !(k.startsWith("_") && mappedKeys.has(k.slice(1)))) unmapped.set(k, (unmapped.get(k) || 0) + 1);
      item.data = data;
      items.push(item);

      // redirects
      const routeItem = { ...item, path: hierarchical ? hierPath(m, p).replace(/^\//, "") : slug, publishedAt: item.publishedAt };
      if (type === "page" && String(m.options.page_on_front) === p.ID && m.options.show_on_front === "page") routeItem.path = "";
      const defTpl = type === "post" ? "/blog/:slug" : type === "page" ? "/:path" : `/${col}/:slug`;
      const to = routeFor([type, col], routeItem, defTpl, ml);
      newUrlOfPost.set(p.ID, to);
      if (status === "published") {
        if (oldPath) { w.redirect({ from: oldPath, to, collection: col, item: id, reason: "permalink", confidence: "high" }); oldToNew.set(oldPath, to); }
        w.redirect({ from: `${hp}${type === "page" ? `/?page_id=${p.ID}` : `/?p=${p.ID}`}`, to, collection: col, item: id, reason: "wp shortlink (query string: use middleware or `has` in next.config)", confidence: "high" });
        for (const old of meta.get("_wp_old_slug") || []) { const op = oldPostPath(m, { ...p, post_name: old }, ctxUrl); if (op) w.redirect({ from: op, to, collection: col, item: id, reason: "_wp_old_slug", confidence: "high" }); }
        if (type === "post" && /%year%/.test(m.options.permalink_structure || "") && p.post_date) { const [y, mo] = p.post_date.split("-"); dateArchives.add(`/${y}`); dateArchives.add(`/${y}/${mo}`); }
      }
    }
    w.addCollection({ collection: col, label: reg?.label || type, titleField: F.title.name, ref: type, fields, items, sourceExtra: { postType: type, registeredBy: reg?.source || (["post", "page"].includes(type) ? "core" : "unknown") } });
  }

  // ---------------------------------------------------------------- taxonomies
  for (const [tx, col] of colOfTax) {
    const terms = [...m.tax.values()].filter((t) => t.taxonomy === tx).map((t) => ({ ...m.terms.get(t.term_id), taxonomy: tx, parent: t.parent, description: t.description, count: t.count })).filter((t) => t.term_id);
    const hier = terms.some((t) => t.parent && t.parent !== "0");
    const fields = [{ name: "name", label: "Name", type: "text", required: true }, { name: "description", label: "Description", type: "text" }, ...(hier ? [{ name: "parent", label: "Parent", type: "reference", to: col }] : [])];
    const items = terms.map((t) => {
      const lang = mlT.langOf.get(String(t.term_id));
      const id = mlT.languages.length > 1 ? termGroupId(t.term_id) : String(t.term_id);
      const item = { id, ...(id !== String(t.term_id) ? { sourceId: String(t.term_id) } : {}), slug: safeDecode(t.slug), ...(lang && mlT.languages.length > 1 ? { locale: lang } : {}), status: "published" };
      const op = oldTermPath(m, t, ctxUrl);
      if (op) item.url = op;
      item.data = { name: decodeEntities(t.name), ...(t.description ? { description: decodeEntities(t.description) } : {}), ...(hier && t.parent && t.parent !== "0" ? { parent: termGroupId(t.parent) } : {}) };
      const defTpl = tx === "category" ? "/blog/category/:slug" : tx === "post_tag" ? "/blog/tag/:slug" : `/${col}/:slug`;
      const to = routeFor([tx, col], item, defTpl, mlT);
      if (op) w.redirect({ from: op, to, collection: col, item: id, reason: "taxonomy archive", confidence: "medium" });
      return item;
    });
    w.addCollection({ collection: col, label: taxDefs.get(tx)?.label || tx, titleField: "name", ref: `taxonomy:${tx}`, fields, items });
  }

  // ---------------------------------------------------------------- users (public display data only)
  if (authorsUsed.size) {
    const items = [...authorsUsed].map((uid) => { const u = m.users.get(uid); const item = { id: String(uid), slug: u.user_nicename || `user-${uid}`, status: "published", url: `${hp}/author/${u.user_nicename}`, data: { name: u.display_name || u.user_nicename } }; if (routesArg.author) w.redirect({ from: item.url, to: fillRoute(routesArg.author, item), collection: "users", item: item.id, reason: "author archive", confidence: "low" }); return item; });
    w.addCollection({ collection: "users", label: "Authors", titleField: "name", ref: "users", fields: [{ name: "name", label: "Display name", type: "text", required: true }], items });
    w.note("Users: only id, nicename and display name are exported (no emails, logins or passwords).");
  }

  // ---------------------------------------------------------------- menus
  const menuTerms = [...m.tax.values()].filter((t) => t.taxonomy === "nav_menu");
  if (menuTerms.length) {
    const items = menuTerms.map((t) => {
      const term = m.terms.get(t.term_id);
      const nav = [...m.posts.values()].filter((p) => p.post_type === "nav_menu_item" && (m.rels.get(p.ID) || []).includes(t.term_taxonomy_id)).sort((a, b) => Number(a.menu_order) - Number(b.menu_order));
      const node = (p) => {
        const kind = metaOf(m, p.ID, "_menu_item_type"), obj = metaOf(m, p.ID, "_menu_item_object"), oid = metaOf(m, p.ID, "_menu_item_object_id");
        let label = p.post_title, url = null, to = null;
        if (kind === "custom") url = metaOf(m, p.ID, "_menu_item_url");
        else if (kind === "post_type") { const tp = m.posts.get(String(oid)); label ||= tp?.post_title; url = tp ? oldPostPath(m, tp, ctxUrl) : null; to = newUrlOfPost.get(String(oid)) || null; }
        else if (kind === "taxonomy") { const tt = [...m.tax.values()].find((x) => x.term_id === String(oid) && x.taxonomy === obj); const tm = tt && { ...m.terms.get(tt.term_id), taxonomy: obj, parent: tt.parent }; label ||= tm?.name; url = tm ? oldTermPath(m, tm, ctxUrl) : null; }
        else if (kind === "post_type_archive") url = `/${types.get(obj)?.rewriteSlug || obj}`;
        return clean({ label: decodeEntities(label || ""), url, newUrl: to && to !== url ? to : undefined, objectType: obj, objectId: oid && kind !== "custom" ? String(oid) : undefined, newTab: metaOf(m, p.ID, "_menu_item_target") === "_blank" || undefined, _id: p.ID, _parent: metaOf(m, p.ID, "_menu_item_menu_item_parent") || "0" });
      };
      const flat = nav.map(node);
      const tree = (parent) => flat.filter((n) => n._parent === parent).map(({ _id, _parent, ...n }) => { const kids = tree(_id); return kids.length ? { ...n, children: kids } : n; });
      return { id: String(t.term_id), slug: term?.slug || `menu-${t.term_id}`, status: "published", data: { name: decodeEntities(term?.name || ""), items: tree("0") } };
    });
    w.addCollection({ collection: "nav-menus", label: "Navigation menus", titleField: "name", ref: "taxonomy:nav_menu", fields: [{ name: "name", label: "Name", type: "text", required: true }, { name: "items", label: "Items", type: "json", structure: "repeater", fields: [{ name: "label", type: "text" }, { name: "url", type: "link" }, { name: "newUrl", type: "text" }, { name: "objectType", type: "text" }, { name: "objectId", type: "text" }, { name: "newTab", type: "boolean" }, { name: "children", type: "json" }] }], items });
  }

  // ---------------------------------------------------------------- extra redirects
  const archiveTo = routesArg.archive || "/blog";
  for (const d of [...dateArchives].sort()) w.redirect({ from: hp + d, to: archiveTo, reason: "date archive", confidence: "low" });
  if (routesArg.feed) w.redirect({ from: `${hp}/feed`, to: routesArg.feed, reason: "RSS feed", confidence: "low" });
  for (const r of m.redirections.filter((r) => r.status !== "disabled" && !Number(r.regex))) {
    const target = String(r.action_data || "");
    const tPath = target.replace(/^https?:\/\/[^/]+/i, "").replace(/\/$/, "") || "/";
    w.redirect({ from: r.url.replace(/\/$/, "") || "/", to: oldToNew.get(tPath) || target, status: Number(r.action_code) || 301, reason: "Redirection plugin rule", confidence: oldToNew.has(tPath) ? "high" : "medium" });
  }
  if (m.redirections.some((r) => Number(r.regex))) w.warn("Redirection plugin regex rules not converted", m.redirections.filter((r) => Number(r.regex)).length);

  // ---------------------------------------------------------------- report extras
  const extra = [];
  extra.push("## WordPress specifics", "", `- Dump prefix \`${m.prefix}\`, site ${site}, permalinks \`${m.options.permalink_structure || "plain"}\`${multi ? `, multilingual (${ml.plugin}: ${ml.languages.join(", ")}, default ${ml.defaultLang}; items share the id of the default-language post, original post id in sourceId)` : ""}`);
  extra.push(`- Exported post types: ${selected.join(", ")}; taxonomies: ${[...colOfTax.keys()].join(", ") || "none"}`);
  const skippedTypes = [...new Set([...m.posts.values()].map((p) => p.post_type))].filter((t) => !m.selected.has(t));
  extra.push(`- Not exported: ${skippedTypes.map((t) => `${t}(${postsOf(t).length})`).join(", ")}${OUT_OF_SCOPE_TYPES.size && skippedTypes.some((t) => OUT_OF_SCOPE_TYPES.has(t)) ? " — WooCommerce data is out of scope" : ""}`);
  if (unserStats.repaired) extra.push(`- ${unserStats.repaired} PHP-serialized values had wrong string lengths and were repaired (usual after a naive search-replace of URLs)`);
  if (unserStats.failed) extra.push(`- ${unserStats.failed} serialized-looking values could not be decoded (kept as strings)`);
  extra.push("", "### Shortcodes left raw", "", ...(shortcodeTotals.size ? [...shortcodeTotals].sort((a, b) => b[1].count - a[1].count).map(([n, e]) => `- \`[${n}]\` ×${e.count} (e.g. ${[...e.items].join(", ")})`) : ["None."]));
  extra.push("", "### Post meta not mapped (add with --meta key1,key2 or define the ACF/JetEngine field)", "", ...(unmapped.size ? [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `- \`${k}\` ×${n}`) : ["None."]));
  return extra.join("\n");
}

// ====================================================================== REST API
async function exportRest() {
  const rawDir = typeof args.fromRaw === "string" ? args.fromRaw : path.join(outDir, "_raw", "wordpress-rest");
  const offline = !!args.fromRaw && !args.url;
  const src = new RestSource({ site: args.url || "offline", rawDir, offline, onRetry: (s, ms) => console.error(`  HTTP ${s}, waiting ${Math.round(ms / 1000)}s`) });
  let disc;
  try { disc = await src.discover(); } catch (e) { die(e.message); }
  const site = String(disc.root?.home || disc.root?.url || src.site).replace(/\/$/, "");
  const maxPages = args.maxPages ? Number(args.maxPages) : Infinity;
  const perPage = Math.min(100, Number(args.perPage) || 100);
  const skip = new Set(["attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_font_family", "wp_font_face", "wp_global_styles"]);
  const typeList = disc.types.filter((t) => t.rest_base && !/[(?]/.test(t.rest_base) && (onlyTypes.length ? onlyTypes.includes(t.slug) || onlyTypes.includes(t.rest_base) : !skip.has(t.slug) && !OUT_OF_SCOPE_TYPES.has(t.slug)));
  const usedCol = new Set();
  const colOfType = new Map(typeList.map((t) => [t.slug, uniqueName(usedCol, slugify(t.slug))]));
  const taxBySlug = new Map(disc.taxonomies.map((t) => [t.slug, t]));
  const fetched = new Map();
  const mediaIds = new Set();
  const usedTax = new Set();
  const termIds = new Map(); // taxonomy -> Set(ids) referenced by exported items
  const authors = new Set();
  const local = (u) => { try { const x = new URL(u); return (x.pathname.replace(/\/$/, "") || "/") + x.search; } catch { return null; } };
  const hp = (() => { try { return new URL(site).pathname.replace(/\/+$/, ""); } catch { return ""; } })();
  for (const t of typeList) {
    const r = await src.all(`/${t.rest_namespace || "wp/v2"}/${t.rest_base}`, { context: "view" }, { perPage, maxPages });
    if (r.status >= 400) { w.warn(`REST type not readable (HTTP ${r.status})`, t.slug); continue; }
    if (r.truncated) w.warn("REST pagination stopped by --max-pages (export is partial)", `${t.slug}: ${r.items.length} of ${r.total ?? "?"} items`);
    fetched.set(t.slug, r.items);
    for (const p of r.items) {
      if (p.featured_media) mediaIds.add(p.featured_media);
      if (p.author) authors.add(p.author);
      for (const tx of t.taxonomies || []) { const v = p[taxBySlug.get(tx)?.rest_base]; if (Array.isArray(v) && v.length) { usedTax.add(tx); const set = termIds.get(tx) || new Set(); v.forEach((id) => set.add(id)); termIds.set(tx, set); } }
    }
  }
  // media by id (featured images); inline images keep their URLs
  const media = new Map();
  const ids = [...mediaIds];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await src.get("/wp/v2/media", { include: ids.slice(i, i + 100).join(","), per_page: 100 });
    if (Array.isArray(r.body)) for (const x of r.body) media.set(x.id, { url: x.source_url, alt: x.alt_text || undefined, width: x.media_details?.width, height: x.media_details?.height, size: x.media_details?.filesize, mime: x.mime_type, filename: x.media_details?.file ? path.basename(x.media_details.file) : undefined, sourceId: String(x.id) });
  }
  const mediaValue = (id, usage) => { const a = media.get(id); if (!a) { w.warn("featured media not readable", `${usage.collection}/${usage.item}: ${id}`); return null; } w.asset(a, usage); return clean({ url: a.url, alt: a.alt, width: a.width, height: a.height, assetId: a.sourceId }); };
  const colOfTax = new Map([...usedTax].map((tx) => [tx, uniqueName(usedCol, usedCol.has(slugify(tx)) ? `tax-${slugify(tx)}` : slugify(tx))]));

  for (const t of typeList) {
    const list = fetched.get(t.slug);
    if (!list) continue;
    const col = colOfType.get(t.slug);
    const used = new Set();
    const fields = [];
    const add = (f) => (fields.push(f), f);
    const F = { title: add({ name: uniqueName(used, "title"), label: "Title", type: "text", required: true, source: { key: "title.rendered" } }), content: add({ name: uniqueName(used, "content"), label: "Content", type: "richtext", source: { key: "content.rendered" } }) };
    if (list.some((p) => stripTags(p.excerpt?.rendered))) F.excerpt = add({ name: uniqueName(used, "excerpt"), label: "Excerpt", type: "text", source: { key: "excerpt.rendered" } });
    if (list.some((p) => p.featured_media)) F.featuredImage = add({ name: uniqueName(used, "featuredImage"), label: "Featured image", type: "image", source: { key: "featured_media" } });
    if (list.some((p) => p.author)) F.author = add({ name: uniqueName(used, "author"), label: "Author", type: "reference", to: "users", source: { key: "author" } });
    if (t.hierarchical) F.parent = add({ name: uniqueName(used, "parent"), label: "Parent", type: "reference", to: col, source: { key: "parent" } });
    if (list.some((p) => p.menu_order)) F.menuOrder = add({ name: uniqueName(used, "menuOrder"), label: "Menu order", type: "number", source: { key: "menu_order" } });
    if (list.some((p) => p.template)) F.template = add({ name: uniqueName(used, "template"), label: "Template", type: "text", source: { key: "template" } });
    if (list.some((p) => p.yoast_head_json?.title)) F.seoTitle = add({ name: uniqueName(used, "seoTitle"), label: "SEO title", type: "text", source: { key: "yoast_head_json.title" } });
    if (list.some((p) => p.yoast_head_json?.description)) F.seoDescription = add({ name: uniqueName(used, "seoDescription"), label: "SEO description", type: "text", source: { key: "yoast_head_json.description" } });
    const taxF = new Map();
    for (const tx of (t.taxonomies || []).filter((x) => colOfTax.has(x))) taxF.set(tx, add({ name: uniqueName(used, tx === "category" ? "categories" : tx === "post_tag" ? "tags" : toFieldName(tx)), label: tx, type: "multi-reference", to: colOfTax.get(tx), source: { key: taxBySlug.get(tx).rest_base } }));
    // ACF / registered meta exposed in REST: no schema, infer from values
    const acfKeys = [...new Set(list.flatMap((p) => (p.acf && !Array.isArray(p.acf) ? Object.keys(p.acf) : [])))];
    const acfF = new Map();
    for (const k of acfKeys) acfF.set(k, add({ name: uniqueName(used, toFieldName(k)), label: k, ...inferRestType(list.map((p) => p.acf?.[k])), inferred: true, source: { key: `acf.${k}` } }));
    const items = list.map((p) => {
      const id = String(p.id);
      const usage = { collection: col, item: id };
      const item = { id, slug: safeDecode(p.slug || "") || `${t.slug}-${id}`, status: p.status === "publish" ? "published" : "draft" };
      if (p.lang) item.locale = p.lang;
      if (p.date_gmt) item.publishedAt = toISODate(p.date_gmt);
      if (p.modified_gmt) item.updatedAt = toISODate(p.modified_gmt);
      const oldPath = p.link ? local(p.link) : null;
      if (oldPath) item.url = oldPath;
      const data = { [F.title.name]: decodeEntities(stripTags(p.title?.rendered || "")) };
      const html = p.content?.rendered || "";
      if (p.content?.protected) w.warn("password-protected content not readable", `${col}/${id}`);
      if (html) { const s = sanitizeHtml(html, { baseUrl: site, onUrl: (u, tag) => tag === "img" && w.asset({ url: u }, { ...usage, field: F.content.name, inline: true }) }); reportSanitizer(s.removed, `${col}/${id}`); addShortcodes(html, `${col}/${id}`); data[F.content.name] = { html: s.html, raw: p.content?.raw ?? html, rawFormat: p.content?.raw ? (/<!--\s*wp:/.test(p.content.raw) ? "gutenberg" : "classic") : "html" }; }
      if (F.excerpt) { const e = decodeEntities(stripTags(p.excerpt?.rendered || "")); if (e) data[F.excerpt.name] = e; }
      if (F.featuredImage && p.featured_media) { const v = mediaValue(p.featured_media, { ...usage, field: F.featuredImage.name }); if (v) data[F.featuredImage.name] = v; }
      if (F.author && p.author) data[F.author.name] = String(p.author);
      if (F.parent && p.parent) data[F.parent.name] = String(p.parent);
      if (F.menuOrder && p.menu_order) data[F.menuOrder.name] = p.menu_order;
      if (F.template && p.template) data[F.template.name] = p.template;
      if (F.seoTitle && p.yoast_head_json?.title) data[F.seoTitle.name] = p.yoast_head_json.title;
      if (F.seoDescription && p.yoast_head_json?.description) data[F.seoDescription.name] = p.yoast_head_json.description;
      for (const [tx, f] of taxF) { const v = p[taxBySlug.get(tx).rest_base]; if (Array.isArray(v) && v.length) data[f.name] = v.map(String); }
      for (const [k, f] of acfF) { const v = restValue(f, p.acf?.[k], { ...usage, field: f.name }); if (v !== null && v !== undefined) data[f.name] = v; }
      item.data = data;
      const defTpl = t.slug === "post" ? "/blog/:slug" : t.slug === "page" ? "/:path" : `/${col}/:slug`;
      const to = routeFor([t.slug, col], { ...item, path: oldPath && t.hierarchical ? oldPath.replace(/^\//, "") : item.slug }, defTpl);
      if (item.status === "published" && oldPath) w.redirect({ from: oldPath, to, collection: col, item: id, reason: "permalink (REST link)", confidence: "high" });
      if (item.status === "published") w.redirect({ from: `${hp}${t.slug === "page" ? `/?page_id=${id}` : `/?p=${id}`}`, to, collection: col, item: id, reason: "wp shortlink (query string)", confidence: "high" });
      return item;
    });
    w.addCollection({ collection: col, label: t.name || t.slug, titleField: F.title.name, ref: t.slug, fields, items, sourceExtra: { restBase: t.rest_base } });
  }
  for (const [tx, col] of colOfTax) {
    const tdef = taxBySlug.get(tx);
    // only the terms the exported items use (+ their parents), fetched by id: polite and complete
    const want = new Set(termIds.get(tx) || []), got = new Map();
    for (let round = 0; round < 4 && [...want].some((id) => !got.has(id)); round++) {
      const ids = [...want].filter((id) => !got.has(id));
      for (let i = 0; i < ids.length; i += 100) {
        const r = await src.get(`/${tdef.rest_namespace || "wp/v2"}/${tdef.rest_base}`, { include: ids.slice(i, i + 100).join(","), per_page: 100 });
        for (const x of Array.isArray(r.body) ? r.body : []) got.set(x.id, x);
        for (const id of ids.slice(i, i + 100)) if (!got.has(id)) got.set(id, null);
      }
      for (const x of got.values()) if (x?.parent) want.add(x.parent);
    }
    const r = { items: [...got.values()].filter(Boolean) };
    const hier = r.items.some((x) => x.parent);
    const items = r.items.map((x) => { const item = { id: String(x.id), slug: safeDecode(x.slug), status: "published", ...(x.link ? { url: local(x.link) } : {}), data: { name: decodeEntities(x.name), ...(x.description ? { description: x.description } : {}), ...(hier && x.parent ? { parent: String(x.parent) } : {}) } }; const to = routeFor([tx, col], item, tx === "category" ? "/blog/category/:slug" : tx === "post_tag" ? "/blog/tag/:slug" : `/${col}/:slug`); if (item.url) w.redirect({ from: item.url, to, collection: col, item: item.id, reason: "taxonomy archive", confidence: "medium" }); return item; });
    w.addCollection({ collection: col, label: tdef.name || tx, titleField: "name", ref: `taxonomy:${tx}`, fields: [{ name: "name", label: "Name", type: "text", required: true }, { name: "description", label: "Description", type: "text" }, ...(hier ? [{ name: "parent", label: "Parent", type: "reference", to: col }] : [])], items });
  }
  if (authors.size) {
    const ids = [...authors];
    const r = { items: [], status: 200 };
    for (let i = 0; i < ids.length; i += 100) { const x = await src.get("/wp/v2/users", { include: ids.slice(i, i + 100).join(","), per_page: 100 }); r.status = x.status; if (Array.isArray(x.body)) r.items.push(...x.body); }
    if (r.status >= 400 || !r.items.length) w.warn("users endpoint not public: author references point to ids without a users collection", `HTTP ${r.status}`);
    else w.addCollection({ collection: "users", label: "Authors", titleField: "name", ref: "users", fields: [{ name: "name", label: "Display name", type: "text", required: true }], items: r.items.map((u) => ({ id: String(u.id), slug: u.slug, status: "published", ...(u.link ? { url: local(u.link) } : {}), data: { name: u.name } })) });
    // keep references consistent: drop author ids the public users endpoint did not return
    const known = new Set(r.items.map((u) => String(u.id)));
    for (const c of w.collections) for (const f of c.fields.filter((x) => x.to === "users")) for (const it of c.items) if (it.data[f.name] && !known.has(it.data[f.name])) { w.warn("author not exposed by /wp/v2/users: reference dropped", `${c.collection}/${it.id}: ${it.data[f.name]}`); delete it.data[f.name]; }
  }
  return [`## WordPress REST specifics`, "", `- Site ${site} (${src.apiRoot === "rest_route" ? "?rest_route=" : "/wp-json"}), ${src.requests} HTTP requests (raw responses in \`${rawDir}\`; replay with --from-raw)`, "- REST exports only published content. `content.rendered` is final HTML (shortcodes expanded, no Gutenberg comments) and is also used as `raw` when `content.raw` is not available (needs auth).", "- ACF values come from the `acf` key (only for field groups with show_in_rest) and their types are inferred (`inferred: true`); prefer the SQL dump for a faithful schema.", "", "### Shortcodes still present in rendered HTML", "", ...(shortcodeTotals.size ? [...shortcodeTotals].map(([n, e]) => `- \`[${n}]\` ×${e.count}`) : ["None."])].join("\n");
}

/** Type inference for REST ACF values (no schema available). */
function inferRestType(values) {
  const vs = values.filter((v) => v !== null && v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && !v.length));
  if (!vs.length) return { type: "text" };
  const isImg = (v) => v && typeof v === "object" && typeof v.url === "string" && (String(v.mime_type || v.type || "").startsWith("image") || v.sizes);
  const isFile = (v) => v && typeof v === "object" && typeof v.url === "string" && (v.mime_type || v.filename);
  const isPost = (v) => v && typeof v === "object" && (v.ID || v.id) && (v.post_type || v.post_title);
  if (vs.every((v) => typeof v === "boolean")) return { type: "boolean" };
  if (vs.every((v) => typeof v === "number")) return { type: "number" };
  if (vs.every(isImg)) return { type: "image" };
  if (vs.every((v) => Array.isArray(v) && v.every(isImg))) return { type: "image", multiple: true };
  if (vs.every(isFile)) return { type: "file" };
  if (vs.every(isPost)) return { type: "reference" };
  if (vs.every((v) => Array.isArray(v) && v.every(isPost))) return { type: "multi-reference" };
  if (vs.every((v) => v && typeof v === "object" && !Array.isArray(v) && "url" in v && "title" in v)) return { type: "link" };
  if (vs.every((v) => typeof v === "string")) {
    if (vs.every((v) => /<\/?(p|br|strong|em|ul|ol|li|h[1-6]|a)\b/i.test(v))) return { type: "richtext" };
    if (vs.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{8}$/.test(v))) return { type: "date" };
    if (vs.every((v) => isUrlLike(v))) return { type: "link" };
    if (vs.every((v) => /^#[0-9a-f]{3,8}$/i.test(v))) return { type: "color" };
    return { type: "text" };
  }
  if (vs.every((v) => Array.isArray(v) && v.every((r) => r && typeof r === "object"))) return { type: "json", structure: "repeater" };
  if (vs.every((v) => v && typeof v === "object" && !Array.isArray(v))) return { type: "json", structure: "group" };
  return { type: "json" };
}

function restValue(field, v, usage) {
  if (v === null || v === undefined || v === "" || v === false && field.type !== "boolean") return null;
  switch (field.type) {
    case "image": { const one = (x) => (x && typeof x === "object" ? (w.asset({ url: x.url, sourceId: x.ID ? String(x.ID) : x.id ? String(x.id) : undefined, alt: x.alt || undefined, width: x.width, height: x.height, mime: x.mime_type, filename: x.filename }, usage), clean({ url: x.url, alt: x.alt || undefined, width: x.width, height: x.height, assetId: x.ID || x.id ? String(x.ID || x.id) : undefined })) : null); return field.multiple ? [].concat(v).map(one).filter(Boolean) : one(v); }
    case "file": w.asset({ url: v.url, mime: v.mime_type, filename: v.filename, size: v.filesize }, usage); return clean({ url: v.url, name: v.filename, mime: v.mime_type, size: v.filesize });
    case "reference": return String(v.ID || v.id || v);
    case "multi-reference": return [].concat(v).map((x) => String(x.ID || x.id || x));
    case "link": return typeof v === "object" ? clean({ url: v.url, label: v.title || undefined, newTab: v.target === "_blank" || undefined }) : String(v);
    case "richtext": { const s = sanitizeHtml(v); return { html: s.html, raw: v, rawFormat: "html" }; }
    case "date": return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : String(v);
    default: return v;
  }
}

function clean(o) { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k]; return o; }
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// ====================================================================== main
const extra = args.dump ? await exportDump() : await exportRest();
const res = w.write({ extraReport: extra });
console.log(`wordpress export (${args.dump ? "SQL dump" : "REST API"}) → ${outDir}/`);
console.log(w.summary());
console.log(`  assets: ${res.assets}, redirects: ${res.redirects}, shortcodes: ${shortcodeTotals.size} kinds, warnings: ${[...w.warnings.values()].reduce((n, x) => n + x.count, 0)} (see ${outDir}/_report.md)`);
