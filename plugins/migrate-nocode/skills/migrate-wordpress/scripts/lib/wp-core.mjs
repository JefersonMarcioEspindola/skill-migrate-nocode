// WordPress model shared by wp-inventory.mjs and wp-export.mjs: loads a SQL dump (streaming), detects the table
// prefix, reads ONLY whitelisted options (wp_options can hold API keys/SMTP passwords/salts), builds post type,
// taxonomy, ACF, JetEngine and CPT UI definitions, permalinks and multilingual groups.
import fs from "node:fs";
import path from "node:path";
import { scanDump } from "./wp-sql.mjs";
import { maybeUnserialize } from "./php-unserialize.mjs";

// ------------------------------------------------------------------ constants

export const OPTION_WHITELIST = new Set([
  "siteurl", "home", "blogname", "blogdescription", "permalink_structure", "category_base", "tag_base", "upload_path", "upload_url_path",
  "active_plugins", "template", "stylesheet", "show_on_front", "page_on_front", "page_for_posts", "WPLANG", "timezone_string", "gmt_offset",
  "cptui_post_types", "cptui_taxonomies", "jet_engine_meta_boxes", "jet_engine_relations", "polylang", "icl_sitepress_settings",
  "acf_version", "woocommerce_version", "elementor_version", "db_version",
]);
/** Option names never read even if a future whitelist entry matched them. */
export const SECRET_OPTION = /pass|secret|token|api_?key|auth_?key|salt|nonce|license|private|credential|smtp/i;

export const BUILTIN_TYPES = new Set(["post", "page", "attachment", "revision", "nav_menu_item", "custom_css", "customize_changeset", "oembed_cache", "user_request", "wp_block", "wp_template", "wp_template_part", "wp_global_styles", "wp_navigation", "wp_font_family", "wp_font_face"]);
export const INTERNAL_TYPES = /^(acf-|elementor_|e-floating|jet-|jet_|wpcf7|wpforms|shop_|product_variation|wc_|scheduled-action|oembed_cache|customize_|nf_sub|flamingo|mc4wp|ct_template|fl-builder|et_pb_layout|astra-|kadence_|wp_|tablepress|frm_|gf_|cookielawinfo|wpcode|rank_math|yoast)/;
export const OUT_OF_SCOPE_TYPES = new Set(["product", "product_variation", "shop_order", "shop_order_refund", "shop_coupon", "shop_subscription"]);
export const SKIP_TAXONOMIES = new Set(["nav_menu", "link_category", "post_format", "language", "post_translations", "term_language", "term_translations", "wp_theme", "wp_template_part_area", "wp_pattern_category", "product_type", "product_visibility", "product_shipping_class", "elementor_library_type", "elementor_library_category"]);
const TABLE_SUFFIX = /(options|posts|postmeta|terms|term_taxonomy|term_relationships|users|icl_translations|jet_post_types|jet_taxonomies|jet_rel_\w+|redirection_items)$/;

// ------------------------------------------------------------------ dump loading

/**
 * loadDump(file, { prefix, metaFor: (postId, postType) => bool | "attachment", metaKeys?: Set, collectMetaStats })
 * Pass 1: options/posts/terms/users/plugin tables. Pass 2 (only when metaFor is given): postmeta of wanted posts.
 * Inventory uses collectMetaStats (single pass, key counts only).
 */
export async function loadDump(file, { prefix: forcedPrefix, metaFor, collectMetaStats = false, keepContent = () => true, onProgress } = {}) {
  const m = {
    file, prefix: forcedPrefix || null, tables: null, options: {}, optionNames: [], posts: new Map(), meta: new Map(),
    terms: new Map(), tax: new Map(), rels: new Map(), users: new Map(), icl: [], jetTypes: [], jetTax: [], jetRels: new Map(), redirections: [],
    metaStats: new Map(), metaPostIds: new Map(), acfRefs: new Map(), prefixes: [],
  };
  const want = (t) => TABLE_SUFFIX.test(t) && (!forcedPrefix || t.startsWith(forcedPrefix));
  const pending = []; // rows of unknown prefix, resolved after the pass
  const statsByTable = new Map(); // postmeta key stats per table (prefix not known yet), never the values
  const res = await scanDump(file, {
    onProgress,
    wantRows: (t) => want(t) && (!t.endsWith("postmeta") || collectMetaStats),
    onRow: (t, row) => {
      if (!t.endsWith("postmeta")) return pending.push([t, slim(t, row)]);
      let st = statsByTable.get(t);
      if (!st) statsByTable.set(t, (st = { metaStats: new Map(), metaPostIds: new Map(), acfRefs: new Map() }));
      metaStat(st, row);
    },
  });
  m.tables = res.tables;
  const names = [...res.tables.keys()];
  m.prefixes = names.filter((n) => n.endsWith("posts") && names.includes(n.slice(0, -5) + "options")).map((n) => n.slice(0, -5)).sort((a, b) => a.length - b.length);
  if (!m.prefix) m.prefix = m.prefixes[0] ?? "wp_";
  const P = m.prefix;
  for (const [t, row] of pending) ingest(m, t.startsWith(P) ? t.slice(P.length) : null, row, keepContent);
  pending.length = 0;
  const st = statsByTable.get(`${P}postmeta`);
  if (st) Object.assign(m, st);

  if (metaFor) {
    await scanDump(file, {
      onProgress,
      wantRows: (t) => t === `${P}postmeta`,
      onRow: (_t, row) => {
        const id = row.post_id;
        const p = m.posts.get(id);
        const w = p ? metaFor(id, p.post_type) : false;
        if (!w) return;
        if (w === "attachment" && !["_wp_attached_file", "_wp_attachment_metadata", "_wp_attachment_image_alt"].includes(row.meta_key)) return;
        addMeta(m, id, row.meta_key, row.meta_value);
      },
    });
  }
  return m;
}

function slim(t, row) {
  if (t.endsWith("users")) return { ID: row.ID, user_nicename: row.user_nicename, display_name: row.display_name }; // never keep pass/email
  if (t.endsWith("options")) {
    const n = row.option_name;
    return { option_name: n, option_value: OPTION_WHITELIST.has(n) && !SECRET_OPTION.test(n.replace(/^(cptui|jet_engine|polylang|icl_sitepress)_?/, "")) ? row.option_value : undefined };
  }
  if (t.endsWith("posts") && row.post_type === "revision") { const { post_content, post_content_filtered, ...rest } = row; return rest; }
  if (t.endsWith("posts")) { delete row.post_password; delete row.post_content_filtered; delete row.to_ping; delete row.pinged; }
  return row;
}

function addMeta(m, id, key, value) {
  let mm = m.meta.get(id);
  if (!mm) m.meta.set(id, (mm = new Map()));
  const list = mm.get(key);
  if (list) list.push(value); else mm.set(key, [value]);
}

function metaStat(st, row) {
  st.metaStats.set(row.meta_key, (st.metaStats.get(row.meta_key) || 0) + 1);
  if (/^_(elementor_data|fl_builder_data|bricks_page_content_2|et_pb_use_builder|wpb_vc_js_status)$|^ct_builder_shortcodes$/.test(row.meta_key)) {
    const s = st.metaPostIds.get(row.meta_key) || new Set(); s.add(row.post_id); st.metaPostIds.set(row.meta_key, s);
  }
  if (row.meta_key?.startsWith("_") && /^field_[a-z0-9]+$/i.test(row.meta_value || "")) st.acfRefs.set(row.meta_value, row.meta_key.slice(1));
}

function ingest(m, t, row, keepContent) {
  if (t === null) return; // other prefix (multisite sub-site) — ignored
  switch (t) {
    case "options":
      m.optionNames.push(row.option_name);
      if (row.option_value !== undefined) m.options[row.option_name] = maybeUnserialize(row.option_value);
      break;
    case "posts":
      if (!keepContent(row.post_type)) delete row.post_content;
      m.posts.set(row.ID, row);
      break;
    case "terms": m.terms.set(row.term_id, { term_id: row.term_id, name: row.name, slug: row.slug }); break;
    case "term_taxonomy": m.tax.set(row.term_taxonomy_id, row); break;
    case "term_relationships": { const l = m.rels.get(row.object_id) || []; l.push(row.term_taxonomy_id); m.rels.set(row.object_id, l); break; }
    case "users": m.users.set(row.ID, row); break;
    case "icl_translations": m.icl.push(row); break;
    case "jet_post_types": m.jetTypes.push({ ...row, labels: maybeUnserialize(row.labels), args: maybeUnserialize(row.args), meta_fields: maybeUnserialize(row.meta_fields) }); break;
    case "jet_taxonomies": m.jetTax.push({ ...row, labels: maybeUnserialize(row.labels), args: maybeUnserialize(row.args), meta_fields: maybeUnserialize(row.meta_fields) }); break;
    case "redirection_items": m.redirections.push({ url: row.url, action_code: row.action_code, action_data: row.action_data, regex: row.regex, status: row.status }); break;
    default:
      if (/^jet_rel_/.test(t) && !/_meta$/.test(t)) { const l = m.jetRels.get(t) || []; l.push(row); m.jetRels.set(t, l); }
  }
}

export const metaOf = (m, id, key) => { const l = m.meta.get(id)?.get(key); return l ? l[l.length - 1] : undefined; };

// ------------------------------------------------------------------ registrations (CPT UI, JetEngine, ACF post types)

export function registeredTypes(m) {
  const out = new Map(); // slug -> { slug, label, source, rewriteSlug, withFront, hierarchical, taxonomies, showInRest, restBase, hasArchive }
  const cpt = m.options.cptui_post_types;
  if (cpt && typeof cpt === "object") for (const [slug, d] of Object.entries(cpt)) {
    out.set(slug, { slug, label: d.label || slug, source: "cptui", rewriteSlug: d.rewrite === "false" ? null : d.rewrite_slug || slug, withFront: d.rewrite_withfront !== "false", hierarchical: d.hierarchical === "true", taxonomies: d.taxonomies || [], showInRest: d.show_in_rest !== "false", restBase: d.rest_base || slug, hasArchive: d.has_archive === "true" ? d.has_archive_string || slug : null });
  }
  for (const j of m.jetTypes) {
    if (j.status !== "publish" || !j.slug) continue;
    const a = j.args || {};
    out.set(j.slug, { slug: j.slug, label: j.labels?.name || j.slug, source: "jetengine", rewriteSlug: a.rewrite === false || a.rewrite === "false" ? null : a.rewrite_slug || j.slug, withFront: a.with_front !== false && a.with_front !== "false", hierarchical: !!a.hierarchical && a.hierarchical !== "false", taxonomies: [], showInRest: a.show_in_rest !== false, restBase: a.rest_base || j.slug, hasArchive: a.has_archive ? j.slug : null, metaFields: Array.isArray(j.meta_fields) ? j.meta_fields : [] });
  }
  for (const p of m.posts.values()) {
    if (p.post_type !== "acf-post-type" || p.post_status !== "publish") continue;
    const s = maybeUnserialize(p.post_content || "");
    if (!s?.post_type) continue;
    out.set(s.post_type, { slug: s.post_type, label: s.labels?.name || p.post_title, source: "acf", rewriteSlug: s.rewrite?.permalink_rewrite === "no_permalink" ? null : s.rewrite?.slug || s.post_type, withFront: s.rewrite?.with_front !== "0" && s.rewrite?.with_front !== false, hierarchical: !!Number(s.hierarchical), taxonomies: s.taxonomies || [], showInRest: !!Number(s.show_in_rest ?? 1), restBase: s.rest_base || s.post_type, hasArchive: Number(s.has_archive) ? s.has_archive_slug || s.post_type : null });
  }
  return out;
}

export function registeredTaxonomies(m) {
  const out = new Map();
  const ct = m.options.cptui_taxonomies;
  if (ct && typeof ct === "object") for (const [slug, d] of Object.entries(ct)) out.set(slug, { slug, label: d.label || slug, source: "cptui", rewriteSlug: d.rewrite === "false" ? null : d.rewrite_slug || slug, objectTypes: d.object_types || [], hierarchical: d.hierarchical === "true" });
  for (const j of m.jetTax) if (j.slug) out.set(j.slug, { slug: j.slug, label: j.labels?.name || j.slug, source: "jetengine", rewriteSlug: j.args?.rewrite_slug || j.slug, objectTypes: j.object_type ? String(j.object_type).split(",") : [], hierarchical: !!j.args?.hierarchical });
  return out;
}

export function jetRelations(m) {
  return m.jetTypes.filter((j) => j.status === "relation").map((j) => {
    const a = j.args || {};
    const obj = (s) => { const [kind, type] = String(s || "").split("::"); return { kind, type }; };
    const table = a.db_table && a.db_table !== "false" ? `jet_rel_${j.id}` : "jet_rel_default";
    const rows = (m.jetRels.get(table) || []).filter((r) => table !== "jet_rel_default" || String(r.rel_id) === String(j.id));
    return { id: String(j.id), name: a.name || j.labels?.name || `relation ${j.id}`, parent: obj(a.parent_object), child: obj(a.child_object), type: a.type, table, rows };
  });
}

// ------------------------------------------------------------------ ACF

/** Field tree from acf-field-group / acf-field posts (+ optional local JSON groups). */
export function acfGroups(m, localJsonGroups = []) {
  const fieldPosts = [...m.posts.values()].filter((p) => p.post_type === "acf-field");
  const byParent = new Map();
  for (const f of fieldPosts) { const l = byParent.get(f.post_parent) || []; l.push(f); byParent.set(f.post_parent, l); }
  const build = (f) => {
    const s = maybeUnserialize(f.post_content || "") || {};
    const node = { key: f.post_name, name: f.post_excerpt, label: f.post_title, type: s.type || "text", required: !!Number(s.required || 0), settings: s, sub_fields: [], layouts: [] };
    const kids = (byParent.get(f.ID) || []).sort((a, b) => Number(a.menu_order) - Number(b.menu_order)).map(build);
    if (node.type === "flexible_content") {
      const layouts = s.layouts && typeof s.layouts === "object" ? Object.values(s.layouts) : [];
      node.layouts = layouts.map((l) => ({ key: l.key, name: l.name, label: l.label, sub_fields: kids.filter((k) => k.settings.parent_layout === l.key) }));
    } else node.sub_fields = kids;
    return node;
  };
  const groups = [...m.posts.values()].filter((p) => p.post_type === "acf-field-group" && p.post_status !== "trash").map((g) => {
    const s = maybeUnserialize(g.post_content || "") || {};
    return { key: g.post_name, title: g.post_title, active: g.post_status === "publish", location: s.location || [], showInRest: !!Number(s.show_in_rest || 0), fields: (byParent.get(g.ID) || []).sort((a, b) => Number(a.menu_order) - Number(b.menu_order)).map(build), source: "db" };
  });
  const fromJson = (f) => ({ key: f.key, name: f.name, label: f.label, type: f.type, required: !!Number(f.required || 0), settings: f, sub_fields: (f.sub_fields || []).map(fromJson), layouts: Object.values(f.layouts || {}).map((l) => ({ key: l.key, name: l.name, label: l.label, sub_fields: (l.sub_fields || []).map(fromJson) })) });
  for (const g of localJsonGroups) if (!groups.some((x) => x.key === g.key)) groups.push({ key: g.key, title: g.title, active: g.active !== false, location: g.location || [], showInRest: !!g.show_in_rest, fields: (g.fields || []).map(fromJson), source: "json" });
  return groups;
}

export function acfLocationTypes(group) {
  const types = new Set();
  for (const or of group.location || []) for (const r of or || []) {
    if (r.operator !== "==") continue;
    if (r.param === "post_type") types.add(r.value);
    if (["page_template", "page_type", "page_parent", "page"].includes(r.param)) types.add("page");
    if (["post_category", "post_format", "post_taxonomy"].includes(r.param)) types.add("post");
  }
  return types;
}

export function readAcfJsonDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return Array.isArray(j) ? j : [j]; } catch { return []; } }).filter((g) => g && g.key && Array.isArray(g.fields));
}

/** Flattens an ACF tree into "type" counts for inventories. */
export function acfTypeCounts(groups) {
  const c = {};
  const walk = (f) => { c[f.type] = (c[f.type] || 0) + 1; f.sub_fields.forEach(walk); f.layouts.forEach((l) => l.sub_fields.forEach(walk)); };
  groups.forEach((g) => g.fields.forEach(walk));
  return c;
}

// ------------------------------------------------------------------ JetEngine meta boxes

export function jetMetaBoxes(m) {
  const boxes = m.options.jet_engine_meta_boxes;
  const list = boxes && typeof boxes === "object" ? Object.values(boxes) : [];
  const out = list.map((b) => ({ name: b.args?.name || "Meta box", objectType: b.args?.object_type || "post", postTypes: [].concat(b.args?.allowed_post_type || []), fields: [].concat(b.meta_fields || []), source: "meta_boxes" }));
  for (const t of registeredTypes(m).values()) if (t.metaFields?.length) out.push({ name: `${t.label} (post type fields)`, objectType: "post", postTypes: [t.slug], fields: t.metaFields, source: "jet_post_types" });
  return out;
}

// ------------------------------------------------------------------ attachments / URLs

export function siteUrl(m, override) {
  return String(override || m.options.home || m.options.siteurl || "").replace(/\/$/, "");
}

export function uploadsBase(m, override) {
  if (m.options.upload_url_path) return String(m.options.upload_url_path).replace(/\/$/, "");
  const site = String(override || m.options.siteurl || m.options.home || "").replace(/\/$/, "");
  const sub = /_(\d+)_$/.exec(m.prefix || "");
  const up = m.options.upload_path && !path.isAbsolute(m.options.upload_path) ? m.options.upload_path : "wp-content/uploads";
  return `${site}/${up.replace(/^\/|\/$/g, "")}${sub && sub[1] !== "1" ? `/sites/${sub[1]}` : ""}`;
}

export function attachments(m, siteOverride, uploadsDir) {
  const base = uploadsBase(m, siteOverride);
  const byId = new Map(), byUrl = new Map();
  for (const p of m.posts.values()) {
    if (p.post_type !== "attachment") continue;
    const file = metaOf(m, p.ID, "_wp_attached_file");
    const md = maybeUnserialize(metaOf(m, p.ID, "_wp_attachment_metadata") || "");
    const url = file ? (/^https?:/i.test(file) ? file : `${base}/${file}`) : p.guid;
    const a = { id: String(p.ID), url, filename: path.basename(file || p.guid || ""), mime: p.post_mime_type || undefined, width: md?.width ? Number(md.width) : undefined, height: md?.height ? Number(md.height) : undefined, size: md?.filesize ? Number(md.filesize) : undefined, alt: metaOf(m, p.ID, "_wp_attachment_image_alt") || undefined, title: p.post_title };
    if (uploadsDir && file) { const lf = path.join(uploadsDir, file); if (fs.existsSync(lf)) a.localFile = lf; }
    byId.set(a.id, a);
    if (url) byUrl.set(stripSize(url), a.id);
    if (p.guid) byUrl.set(stripSize(p.guid), a.id);
  }
  return { byId, byUrl, base };
}

/** ".../cover-1024x576.jpg?x" -> ".../cover.jpg" (WordPress intermediate sizes) */
export const stripSize = (u) => String(u).split("?")[0].replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1").replace(/-scaled(\.[a-z0-9]+)$/i, "$1").replace(/^https?:\/\//i, "//");

// ------------------------------------------------------------------ multilingual

/**
 * Returns { languages: [codes], defaultLang, langOf: Map(postId -> code), groupOf: Map(postId -> groupId), plugin }
 * groupId = id of the default-language post of the translation group (the item id shared across locales).
 */
export function multilingual(m, kind = "post") {
  const out = { plugin: null, languages: [], defaultLang: null, langOf: new Map(), groupOf: new Map() };
  const langTax = kind === "post" ? "language" : "term_language";
  const trTax = kind === "post" ? "post_translations" : "term_translations";
  const ttLang = new Map(), ttGroup = new Map();
  for (const t of m.tax.values()) {
    if (t.taxonomy === langTax) ttLang.set(t.term_taxonomy_id, (m.terms.get(t.term_id)?.slug || "").replace(/^pll_/, ""));
    if (t.taxonomy === trTax) ttGroup.set(t.term_taxonomy_id, maybeUnserialize(t.description));
  }
  if (ttLang.size || m.options.polylang) {
    out.plugin = "polylang";
    out.defaultLang = m.options.polylang?.default_lang || null;
    for (const [obj, list] of m.rels) for (const tt of list) {
      if (ttLang.has(tt)) out.langOf.set(obj, ttLang.get(tt));
      const g = ttGroup.get(tt);
      if (g && typeof g === "object") { const ids = Object.entries(g).filter(([k]) => k !== "sync"); const def = ids.find(([l]) => l === out.defaultLang) || ids[0]; if (def) out.groupOf.set(obj, String(def[1])); }
    }
    out.languages = [...new Set([...ttLang.values()])].filter(Boolean);
  } else if (m.icl.length) {
    out.plugin = "wpml";
    out.defaultLang = m.options.icl_sitepress_settings?.default_language || null;
    const prefix = kind === "post" ? "post_" : "tax_";
    const rows = m.icl.filter((r) => String(r.element_type).startsWith(prefix));
    const byTrid = new Map();
    for (const r of rows) { const l = byTrid.get(r.trid) || []; l.push(r); byTrid.set(r.trid, l); }
    for (const list of byTrid.values()) {
      const orig = list.find((r) => !r.source_language_code) || list[0];
      for (const r of list) {
        const id = kind === "post" ? String(r.element_id) : termIdOfTT(m, r.element_id);
        out.langOf.set(id, r.language_code);
        out.groupOf.set(id, kind === "post" ? String(orig.element_id) : termIdOfTT(m, orig.element_id));
      }
    }
    out.languages = [...new Set(rows.map((r) => r.language_code))];
  }
  if (!out.defaultLang && out.languages.length) out.defaultLang = out.languages[0];
  return out;
}
const termIdOfTT = (m, ttId) => String(m.tax.get(String(ttId))?.term_id ?? ttId);

// ------------------------------------------------------------------ permalinks

/** Static front of the permalink structure ("/blog/%postname%/" -> "/blog"). */
export function permalinkFront(m) {
  const s = m.options.permalink_structure || "";
  const i = s.indexOf("%");
  return i > 0 ? s.slice(0, i).replace(/\/$/, "") : "";
}

/**
 * Old public path of a post as WordPress would build it (trailing slash removed). null when not public.
 * ctx: { types: registeredTypes, front, langOf, defaultLang }
 */
export function oldPostPath(m, p, ctx) {
  if (!["publish"].includes(p.post_status)) return null;
  const structure = m.options.permalink_structure || "";
  const lang = ctx.langOf?.get(p.ID);
  const langPrefix = lang && lang !== ctx.defaultLang ? `/${lang}` : "";
  let out;
  if (p.post_type === "page") {
    if (String(m.options.page_on_front) === p.ID && m.options.show_on_front === "page") return langPrefix || "/";
    out = structure ? hierPath(m, p) : `/?page_id=${p.ID}`;
  } else if (p.post_type === "post") {
    if (!structure) out = `/?p=${p.ID}`;
    else {
      const d = (p.post_date || "").match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/) || [];
      const cat = primaryCategoryPath(m, p);
      out = structure.replace(/%year%/g, d[1] || "").replace(/%monthnum%/g, d[2] || "").replace(/%day%/g, d[3] || "").replace(/%hour%/g, d[4] || "").replace(/%minute%/g, d[5] || "").replace(/%second%/g, d[6] || "")
        .replace(/%post_id%/g, p.ID).replace(/%postname%/g, p.post_name).replace(/%category%/g, cat).replace(/%author%/g, m.users.get(p.post_author)?.user_nicename || "");
    }
  } else {
    const t = ctx.types.get(p.post_type);
    if (!structure) out = `/?${p.post_type}=${p.post_name}`;
    else {
      const slug = t ? t.rewriteSlug : p.post_type;
      if (slug === null) return null;
      out = `${t && t.withFront ? ctx.front : ""}/${slug}${t?.hierarchical ? hierPath(m, p) : `/${p.post_name}`}`;
    }
  }
  out = (langPrefix + out).replace(/\/{2,}/g, "/");
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}

export function hierPath(m, p) {
  const parts = [];
  let cur = p, guard = 0;
  while (cur && guard++ < 20) { parts.unshift(cur.post_name); cur = cur.post_parent && cur.post_parent !== "0" ? m.posts.get(cur.post_parent) : null; }
  return "/" + parts.join("/");
}

function primaryCategoryPath(m, p) {
  const primary = metaOf(m, p.ID, "_yoast_wpseo_primary_category") || metaOf(m, p.ID, "rank_math_primary_category");
  const cats = termsOf(m, p.ID, "category").sort((a, b) => Number(a.term_id) - Number(b.term_id));
  const t = cats.find((c) => c.term_id === primary) || cats[0];
  return t ? termPath(m, t) : "uncategorized";
}

export function termsOf(m, objectId, taxonomy) {
  return (m.rels.get(objectId) || []).map((tt) => m.tax.get(tt)).filter((t) => t && (!taxonomy || t.taxonomy === taxonomy)).map((t) => ({ ...m.terms.get(t.term_id), taxonomy: t.taxonomy, parent: t.parent, description: t.description, term_taxonomy_id: t.term_taxonomy_id, count: t.count }));
}

export function termPath(m, term) {
  const parts = [];
  let cur = term, guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.slug);
    const parentTT = cur.parent && cur.parent !== "0" ? [...m.tax.values()].find((t) => t.term_id === cur.parent && t.taxonomy === (term.taxonomy || cur.taxonomy)) : null;
    cur = parentTT ? { ...m.terms.get(parentTT.term_id), parent: parentTT.parent, taxonomy: parentTT.taxonomy } : null;
  }
  return parts.join("/");
}

export function oldTermPath(m, term, ctx) {
  const structure = m.options.permalink_structure || "";
  if (!structure) return term.taxonomy === "category" ? `/?cat=${term.term_id}` : term.taxonomy === "post_tag" ? `/?tag=${term.slug}` : `/?${term.taxonomy}=${term.slug}`;
  let base;
  if (term.taxonomy === "category") base = `${ctx.front}/${m.options.category_base || "category"}`;
  else if (term.taxonomy === "post_tag") base = `${ctx.front}/${m.options.tag_base || "tag"}`;
  else { const t = ctx.taxonomies.get(term.taxonomy); if (t?.rewriteSlug === null) return null; base = `/${t?.rewriteSlug || term.taxonomy}`; }
  const hier = term.taxonomy === "category" || ctx.taxonomies.get(term.taxonomy)?.hierarchical;
  return `${base}/${hier ? termPath(m, term) : term.slug}`.replace(/\/{2,}/g, "/");
}

// ------------------------------------------------------------------ text helpers

const BLOCK_TAGS = "table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary|iframe|script|video|audio|!--";

/** Simplified wpautop(): wraps loose text in <p>, single newlines become <br>. */
export function wpautop(text) {
  let t = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!t.trim()) return "";
  t = t.replace(new RegExp(`(<(?:${BLOCK_TAGS})[\\s/>])`, "gi"), "\n\n$1").replace(new RegExp(`(</(?:${BLOCK_TAGS})>)`, "gi"), "$1\n\n");
  const startsBlock = new RegExp(`^</?(?:${BLOCK_TAGS})[\\s/>]`, "i");
  return t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => (startsBlock.test(p) ? p : `<p>${p.replace(/\n/g, "<br>\n")}</p>`)).join("\n");
}

export const BUILDERS = [
  ["elementor", (meta) => meta.has("_elementor_data") && (meta.get("_elementor_edit_mode")?.[0] ?? "builder") === "builder"],
  ["beaver-builder", (meta) => meta.has("_fl_builder_data")],
  ["bricks", (meta) => meta.has("_bricks_page_content_2")],
  ["oxygen", (meta) => meta.has("ct_builder_shortcodes")],
  ["divi", (meta, c) => meta.get("_et_pb_use_builder")?.[0] === "on" || /\[et_pb_section/.test(c)],
  ["wpbakery", (meta, c) => /\[vc_row/.test(c)],
];

export function pluginList(m) {
  const ap = m.options.active_plugins;
  return Array.isArray(ap) ? ap.map(String) : ap && typeof ap === "object" ? Object.values(ap).map(String) : [];
}

export const KNOWN_PLUGINS = {
  "advanced-custom-fields": "ACF", "advanced-custom-fields-pro": "ACF Pro", "secure-custom-fields": "SCF (ACF fork)", "custom-post-type-ui": "CPT UI", "jet-engine": "JetEngine", "elementor": "Elementor", "elementor-pro": "Elementor Pro",
  "wordpress-seo": "Yoast SEO", "wordpress-seo-premium": "Yoast SEO Premium", "seo-by-rank-math": "Rank Math", "all-in-one-seo-pack": "AIOSEO", "wp-seopress": "SEOPress", "woocommerce": "WooCommerce", "sitepress-multilingual-cms": "WPML",
  "polylang": "Polylang", "polylang-pro": "Polylang Pro", "redirection": "Redirection", "js_composer": "WPBakery", "beaver-builder-lite-version": "Beaver Builder", "bb-plugin": "Beaver Builder", "oxygen": "Oxygen", "pods": "Pods", "meta-box": "Meta Box", "toolset-types": "Toolset Types", "contact-form-7": "Contact Form 7", "wpforms-lite": "WPForms", "gravityforms": "Gravity Forms",
};
