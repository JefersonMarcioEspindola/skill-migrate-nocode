#!/usr/bin/env node
// Inventory of a WordPress site before exporting its content. Any combination of inputs:
//   --folder <path>   a WordPress install (root or wp-content/) copied into the project: themes, plugins + versions
//                     (from file headers), uploads size, ACF local JSON, table prefix. wp-config.php is NEVER printed or
//                     copied: only $table_prefix is read from it.
//   --dump <file.sql> a mysqldump (streamed, any size): post types (core, CPT UI, JetEngine, ACF), taxonomies, ACF field
//                     groups, JetEngine meta boxes/relations, page-builder data, SEO meta, menus, WooCommerce, multilingual.
//   --url <site>      the public REST API (/wp-json): types, taxonomies, counts, exposed plugins (namespaces), ACF/SEO exposure.
//
// Usage:
//   node wp-inventory.mjs [--folder wp/] [--dump db.sql] [--url https://example.com] [--out content/_inventory]
//        [--prefix wp_] [--acf-json theme/acf-json] [--from-raw content/_raw/wordpress-rest]
// Writes <out>/wp-inventory.json and wp-inventory.md; prints a short summary. Values of options, user data and
// credentials are never read or written.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die, preview, findShortcodes } from "./lib/content-common.mjs";
import { loadDump, registeredTypes, registeredTaxonomies, acfGroups, acfLocationTypes, acfTypeCounts, readAcfJsonDir, jetMetaBoxes, jetRelations, multilingual, pluginList, KNOWN_PLUGINS, BUILTIN_TYPES, INTERNAL_TYPES, OUT_OF_SCOPE_TYPES, SKIP_TAXONOMIES, permalinkFront } from "./lib/wp-core.mjs";
import { RestSource, pluginsFromNamespaces } from "./lib/wp-rest.mjs";

const HELP = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
const args = parseArgs();
if (args.help || !(args.folder || args.dump || args.url)) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const outDir = typeof args.out === "string" ? args.out : "content/_inventory";
const inv = { generatedAt: new Date().toISOString(), inputs: {} };
const md = ["# WordPress inventory", ""];
const lines = [];
const acfJsonDirs = []; // theme acf-json folders found by --folder

// ------------------------------------------------------------------ folder
if (args.folder) {
  const root = path.resolve(String(args.folder));
  if (!fs.existsSync(root)) die(`folder not found: ${args.folder}`);
  const wpContent = path.basename(root) === "wp-content" ? root : fs.existsSync(path.join(root, "wp-content")) ? path.join(root, "wp-content") : null;
  const wpRoot = wpContent ? path.dirname(wpContent) : root;
  const F = { root: args.folder, wpContent: wpContent ? path.relative(process.cwd(), wpContent) : null };
  // wp-config.php: only $table_prefix (never print/copy the file: it holds DB credentials and salts)
  for (const cand of [path.join(wpRoot, "wp-config.php"), path.join(path.dirname(wpRoot), "wp-config.php")]) {
    if (!fs.existsSync(cand)) continue;
    const m = /^\s*\$table_prefix\s*=\s*['"]([A-Za-z0-9_]+)['"]/m.exec(fs.readFileSync(cand, "utf8"));
    F.wpConfig = { present: true, tablePrefix: m ? m[1] : null, note: "credentials and salts not read" };
    break;
  }
  const header = (file, keys) => {
    const txt = fs.readFileSync(file, "utf8").slice(0, 8192);
    const o = {};
    for (const k of keys) { const m = new RegExp(`^[ \\t/*#@]*${k}:(.*)$`, "mi").exec(txt); if (m) o[k] = m[1].replace(/\*\/.*$/, "").trim(); }
    return o;
  };
  if (wpContent) {
    const themesDir = path.join(wpContent, "themes");
    F.themes = fs.existsSync(themesDir) ? fs.readdirSync(themesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const css = path.join(themesDir, d.name, "style.css");
      const h = fs.existsSync(css) ? header(css, ["Theme Name", "Version", "Template", "Text Domain"]) : {};
      const acfJson = path.join(themesDir, d.name, "acf-json");
      const groups = readAcfJsonDir(acfJson);
      if (groups.length) acfJsonDirs.push(acfJson);
      return { dir: d.name, name: h["Theme Name"] || d.name, version: h.Version, parent: h.Template, acfJsonGroups: groups.length || undefined, acfJsonFields: groups.length ? groups.reduce((n, g) => n + g.fields.length, 0) : undefined, blockTheme: fs.existsSync(path.join(themesDir, d.name, "theme.json")) || undefined };
    }) : [];
    const plugDir = path.join(wpContent, "plugins");
    const plugins = [];
    if (fs.existsSync(plugDir)) for (const d of fs.readdirSync(plugDir, { withFileTypes: true })) {
      const full = path.join(plugDir, d.name);
      const files = d.isDirectory() ? fs.readdirSync(full).filter((f) => f.endsWith(".php")).map((f) => path.join(full, f)) : d.name.endsWith(".php") ? [full] : [];
      for (const f of files) {
        let h; try { h = header(f, ["Plugin Name", "Version", "Requires at least"]); } catch { continue; }
        if (h["Plugin Name"]) { plugins.push({ dir: d.name, file: path.basename(f), name: h["Plugin Name"], version: h.Version, known: KNOWN_PLUGINS[d.name] }); break; }
      }
    }
    F.plugins = plugins;
    const mu = path.join(wpContent, "mu-plugins");
    F.muPlugins = fs.existsSync(mu) ? fs.readdirSync(mu).filter((f) => f.endsWith(".php") || fs.statSync(path.join(mu, f)).isDirectory()) : [];
    // uploads tree
    const up = path.join(wpContent, "uploads");
    if (fs.existsSync(up)) {
      const U = { files: 0, bytes: 0, byExt: {}, byYear: {}, resizedVariants: 0 };
      const walk = (dir, depth) => {
        if (depth > 8) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walk(p, depth + 1); continue; }
          const st = fs.statSync(p);
          U.files++; U.bytes += st.size;
          const ext = path.extname(e.name).toLowerCase() || "(none)";
          U.byExt[ext] = (U.byExt[ext] || 0) + 1;
          const y = path.relative(up, p).split(path.sep)[0];
          if (/^\d{4}$/.test(y)) U.byYear[y] = (U.byYear[y] || 0) + 1;
          if (/-\d+x\d+\.[a-z]+$/i.test(e.name)) U.resizedVariants++;
        }
      };
      walk(up, 0);
      F.uploads = U;
    }
  }
  F.sqlFiles = [];
  const findSql = (dir, depth) => { if (depth > 2 || !fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory() && !["uploads", "plugins", "node_modules", ".git"].includes(e.name)) findSql(path.join(dir, e.name), depth + 1); else if (/\.sql(\.gz)?$/i.test(e.name)) F.sqlFiles.push({ file: path.relative(process.cwd(), path.join(dir, e.name)), mb: +(fs.statSync(path.join(dir, e.name)).size / 1e6).toFixed(1) }); } };
  findSql(wpRoot, 0);
  inv.inputs.folder = F;
  md.push("## Folder", "", `- wp-content: \`${F.wpContent || "not found"}\``, `- wp-config.php: ${F.wpConfig ? `present, table prefix \`${F.wpConfig.tablePrefix ?? "?"}\` (credentials not read)` : "not found"}`);
  if (F.themes) md.push(`- Themes: ${F.themes.map((t) => `${t.name}${t.version ? " " + t.version : ""}${t.parent ? ` (child of ${t.parent})` : ""}${t.acfJsonGroups ? `, acf-json: ${t.acfJsonGroups} groups` : ""}${t.blockTheme ? ", block theme" : ""}`).join("; ") || "none"}`);
  if (F.plugins) md.push(`- Plugins (${F.plugins.length}): ${F.plugins.map((p) => `${p.name}${p.version ? " " + p.version : ""}`).join(", ")}`);
  if (F.muPlugins?.length) md.push(`- mu-plugins: ${F.muPlugins.join(", ")}`);
  if (F.uploads) md.push(`- Uploads: ${F.uploads.files} files, ${(F.uploads.bytes / 1e6).toFixed(1)} MB (${F.uploads.resizedVariants} resized variants); by year: ${Object.entries(F.uploads.byYear).map(([y, n]) => `${y}:${n}`).join(" ")}; by ext: ${Object.entries(F.uploads.byExt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}:${n}`).join(" ")}`);
  if (F.sqlFiles.length) md.push(`- SQL dumps found: ${F.sqlFiles.map((s) => `\`${s.file}\` (${s.mb} MB)`).join(", ")} → run with --dump`);
  md.push("");
  lines.push(`folder: ${F.plugins?.length ?? 0} plugins, ${F.themes?.length ?? 0} themes, uploads ${F.uploads ? (F.uploads.bytes / 1e6).toFixed(0) + " MB" : "n/a"}${F.wpConfig?.tablePrefix ? `, prefix ${F.wpConfig.tablePrefix}` : ""}`);
  if (!args.prefix && F.wpConfig?.tablePrefix) args.prefix = F.wpConfig.tablePrefix;
}

// ------------------------------------------------------------------ dump
if (args.dump) {
  const file = String(args.dump);
  if (!fs.existsSync(file)) die(`dump not found: ${file}`);
  if (/\.gz$/i.test(file)) die("gzip'ed dump: decompress it first (gunzip -k file.sql.gz)");
  const t0 = Date.now();
  const m = await loadDump(file, { prefix: typeof args.prefix === "string" ? args.prefix : undefined, collectMetaStats: true, keepContent: (t) => !["revision"].includes(t) });
  const posts = [...m.posts.values()];
  const byType = {};
  for (const p of posts) { const t = (byType[p.post_type] ||= { total: 0, byStatus: {} }); t.total++; t.byStatus[p.post_status] = (t.byStatus[p.post_status] || 0) + 1; }
  const regTypes = registeredTypes(m);
  const regTax = registeredTaxonomies(m);
  const taxCounts = {};
  for (const t of m.tax.values()) taxCounts[t.taxonomy] = (taxCounts[t.taxonomy] || 0) + 1;
  const localAcf = [...acfJsonDirs, ...(typeof args.acfJson === "string" ? [args.acfJson] : [])].flatMap(readAcfJsonDir);
  const groups = acfGroups(m, localAcf);
  const boxes = jetMetaBoxes(m);
  const rels = jetRelations(m);
  const ml = multilingual(m);
  const plugins = pluginList(m);
  const metaTop = [...m.metaStats].filter(([k]) => !/^_(edit_lock|edit_last|wp_old_date|encloseme|pingme)$/.test(k)).sort((a, b) => b[1] - a[1]);
  const seo = { yoast: metaTop.filter(([k]) => k.startsWith("_yoast_wpseo_")).reduce((n, [, c]) => n + c, 0), rankMath: metaTop.filter(([k]) => k.startsWith("rank_math_")).reduce((n, [, c]) => n + c, 0), seopress: metaTop.filter(([k]) => k.startsWith("_seopress_")).reduce((n, [, c]) => n + c, 0), aioseoTable: m.tables.has(`${m.prefix}aioseo_posts`) };
  const builders = Object.fromEntries([...m.metaPostIds].map(([k, s]) => [k, s.size]));
  const elementorByType = {};
  for (const id of m.metaPostIds.get("_elementor_data") || []) { const t = m.posts.get(id)?.post_type || "?"; elementorByType[t] = (elementorByType[t] || 0) + 1; }
  const shortcodes = new Map();
  for (const p of posts) if (p.post_content && !INTERNAL_TYPES.test(p.post_type) && p.post_type !== "revision") for (const [n, c] of findShortcodes(p.post_content)) shortcodes.set(n, (shortcodes.get(n) || 0) + c);
  const contentTypes = Object.keys(byType).filter((t) => !INTERNAL_TYPES.test(t) && !["attachment", "revision", "nav_menu_item", "custom_css", "customize_changeset", "oembed_cache", "user_request"].includes(t) && !OUT_OF_SCOPE_TYPES.has(t));
  const D = {
    file: path.basename(file), mb: +(fs.statSync(file).size / 1e6).toFixed(1), seconds: +((Date.now() - t0) / 1000).toFixed(1),
    prefix: m.prefix, otherPrefixes: m.prefixes.filter((p) => p !== m.prefix),
    site: { home: m.options.home, siteurl: m.options.siteurl, name: m.options.blogname, permalinkStructure: m.options.permalink_structure ?? "", front: permalinkFront(m), categoryBase: m.options.category_base || "category", tagBase: m.options.tag_base || "tag", showOnFront: m.options.show_on_front, theme: m.options.stylesheet, parentTheme: m.options.template !== m.options.stylesheet ? m.options.template : undefined },
    tables: Object.fromEntries([...m.tables].map(([k, v]) => [k, v.rows])),
    activePlugins: plugins.map((p) => ({ file: p, known: KNOWN_PLUGINS[p.split("/")[0]] })),
    postTypes: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1].total - a[1].total).map(([t, v]) => [t, { ...v, builtin: BUILTIN_TYPES.has(t) || undefined, registeredBy: regTypes.get(t)?.source, internal: INTERNAL_TYPES.test(t) || undefined, outOfScope: OUT_OF_SCOPE_TYPES.has(t) || undefined }])),
    contentTypeCandidates: contentTypes,
    registeredTypes: [...regTypes.values()].map(({ metaFields, ...t }) => ({ ...t, metaFields: metaFields?.length })),
    taxonomies: Object.fromEntries(Object.entries(taxCounts).map(([t, n]) => [t, { terms: n, registeredBy: regTax.get(t)?.source, skipped: SKIP_TAXONOMIES.has(t) || undefined }])),
    acf: { version: m.options.acf_version, groups: groups.map((g) => ({ key: g.key, title: g.title, active: g.active, source: g.source, locations: [...acfLocationTypes(g)], showInRest: g.showInRest, fields: g.fields.map(function f(x) { return { name: x.name, key: x.key, type: x.type, ...(x.sub_fields.length ? { sub_fields: x.sub_fields.map(f) } : {}), ...(x.layouts.length ? { layouts: x.layouts.map((l) => ({ name: l.name, sub_fields: l.sub_fields.map(f) })) } : {}) }; }) })), typeCounts: acfTypeCounts(groups), referencedKeysWithoutDefinition: [...m.acfRefs.keys()].filter((k) => !JSON.stringify(groups).includes(`"${k}"`)).length },
    jetEngine: { metaBoxes: boxes.map((b) => ({ name: b.name, objectType: b.objectType, postTypes: b.postTypes, source: b.source, fields: b.fields.filter((f) => (f.object_type || "field") === "field").map((f) => ({ name: f.name, type: f.type, ...(f["repeater-fields"] ? { sub: f["repeater-fields"].map((s) => `${s.name}:${s.type}`) } : {}) })) })), relations: rels.map((r) => ({ id: r.id, name: r.name, parent: `${r.parent.kind}::${r.parent.type}`, child: `${r.child.kind}::${r.child.type}`, type: r.type, table: r.table, rows: r.rows.length })), cctTables: [...m.tables.keys()].filter((t) => t.startsWith(`${m.prefix}jet_cct_`)) },
    pageBuilders: { metaPosts: builders, elementorByType, elementorTemplates: byType.elementor_library?.total || 0 },
    seo,
    menus: { menus: taxCounts.nav_menu || 0, items: byType.nav_menu_item?.total || 0 },
    woocommerce: { products: byType.product?.total || 0, variations: byType.product_variation?.total || 0, orders: (byType.shop_order?.total || 0) + (m.tables.get(`${m.prefix}wc_orders`)?.rows || 0), note: "out of scope (counts only; orders are personal data)" },
    multilingual: { plugin: ml.plugin, defaultLang: ml.defaultLang, languages: ml.languages, postsWithLanguage: ml.langOf.size },
    redirectionPlugin: m.redirections.length,
    comments: m.tables.get(`${m.prefix}comments`)?.rows || 0,
    users: m.users.size,
    shortcodes: Object.fromEntries([...shortcodes].sort((a, b) => b[1] - a[1])),
    topMetaKeys: Object.fromEntries(metaTop.slice(0, 40)),
    optionNamesByPrefix: Object.fromEntries(Object.entries(m.optionNames.reduce((acc, n) => { const k = n.replace(/^_(site_)?transient_.*/, "_transient").split(/[_-]/)[0] || n; acc[k] = (acc[k] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 25)),
  };
  inv.inputs.dump = D;
  md.push("## Database dump", "", `- \`${D.file}\` (${D.mb} MB, parsed in ${D.seconds}s), table prefix \`${D.prefix}\`${D.otherPrefixes.length ? ` (also: ${D.otherPrefixes.join(", ")} → multisite?)` : ""}`, `- Site: ${D.site.home} — "${preview(D.site.name)}"; permalinks \`${D.site.permalinkStructure || "plain (?p=ID)"}\`; category base \`${D.site.categoryBase}\`, tag base \`${D.site.tagBase}\`; theme ${D.site.theme}${D.site.parentTheme ? ` (child of ${D.site.parentTheme})` : ""}`, `- Active plugins (${D.activePlugins.length}): ${D.activePlugins.map((p) => p.known || p.file.split("/")[0]).join(", ")}`, "");
  md.push("### Post types", "", "| type | total | statuses | notes |", "|---|---|---|---|");
  for (const [t, v] of Object.entries(D.postTypes)) md.push(`| ${t} | ${v.total} | ${Object.entries(v.byStatus).map(([s, n]) => `${s}:${n}`).join(" ")} | ${[v.builtin && "core", v.registeredBy && `registered by ${v.registeredBy}`, v.internal && "internal", v.outOfScope && "out of scope", D.contentTypeCandidates.includes(t) && "**export candidate**"].filter(Boolean).join(", ")} |`);
  md.push("", "### Taxonomies", "", ...Object.entries(D.taxonomies).map(([t, v]) => `- ${t}: ${v.terms} terms${v.registeredBy ? ` (${v.registeredBy})` : ""}${v.skipped ? " (not exported)" : ""}`), "");
  md.push("### ACF", "", `Version ${D.acf.version || "?"}; ${D.acf.groups.length} field groups; field types: ${Object.entries(D.acf.typeCounts).map(([t, n]) => `${t}×${n}`).join(", ") || "none"}${D.acf.referencedKeysWithoutDefinition ? `; **${D.acf.referencedKeysWithoutDefinition} field keys used in postmeta have no definition in the DB** (groups registered in PHP or acf-json: pass --acf-json)` : ""}`, "");
  for (const g of D.acf.groups) md.push(`- **${g.title}** (${g.key}, ${g.source}${g.active ? "" : ", inactive"}) → ${g.locations.join(", ") || "location not by post type"}${g.showInRest ? ", show_in_rest" : ""}: ${g.fields.map(function s(f) { return `${f.name}:${f.type}${f.sub_fields ? `[${f.sub_fields.map(s).join(", ")}]` : ""}${f.layouts ? `{${f.layouts.map((l) => `${l.name}: ${l.sub_fields.map(s).join(", ")}`).join(" | ")}}` : ""}`; }).join(", ")}`);
  md.push("", "### JetEngine", "", ...(D.jetEngine.metaBoxes.length ? D.jetEngine.metaBoxes.map((b) => `- Meta box **${b.name}** (${b.objectType} → ${b.postTypes.join(", ")}): ${b.fields.map((f) => `${f.name}:${f.type}${f.sub ? `[${f.sub.join(", ")}]` : ""}`).join(", ")}`) : ["- no meta boxes"]), ...D.jetEngine.relations.map((r) => `- Relation **${r.name}** #${r.id}: ${r.parent} → ${r.child} (${r.type}, ${r.table}, ${r.rows} rows)`), ...(D.jetEngine.cctTables.length ? [`- Custom Content Type tables: ${D.jetEngine.cctTables.join(", ")} (not exported: export them as CSV from JetEngine)`] : []), "");
  md.push("### Page builders, SEO, menus, other", "", `- Builder data: ${JSON.stringify(D.pageBuilders.metaPosts)}; Elementor by type: ${JSON.stringify(D.pageBuilders.elementorByType)}; Elementor templates: ${D.pageBuilders.elementorTemplates}. Builder JSON is noted, not converted (rebuild those pages as components).`, `- SEO meta rows: Yoast ${seo.yoast}, Rank Math ${seo.rankMath}, SEOPress ${seo.seopress}${seo.aioseoTable ? ", AIOSEO table present" : ""}`, `- Menus: ${D.menus.menus} menus, ${D.menus.items} items`, `- WooCommerce: ${D.woocommerce.products} products, ${D.woocommerce.orders} orders (${D.woocommerce.note})`, `- Multilingual: ${D.multilingual.plugin ? `${D.multilingual.plugin}, default ${D.multilingual.defaultLang}, languages ${D.multilingual.languages.join(", ")}` : "none"}`, `- Redirection plugin rules: ${D.redirectionPlugin}; comments: ${D.comments} (not exported); users: ${D.users} (only display names/slugs are ever exported)`, `- Shortcodes in content: ${Object.entries(D.shortcodes).map(([n, c]) => `[${n}]×${c}`).join(", ") || "none"}`, `- Top meta keys: ${Object.entries(D.topMetaKeys).slice(0, 25).map(([k, n]) => `${k}:${n}`).join(", ")}`, "");
  lines.push(`dump: prefix ${D.prefix}, ${posts.length} posts rows; content types: ${contentTypes.map((t) => `${t}(${byType[t].total})`).join(", ")}; ACF groups ${groups.length}; Jet boxes ${boxes.length}; builders ${JSON.stringify(D.pageBuilders.metaPosts)}; ${D.multilingual.plugin || "monolingual"}`);
}

// ------------------------------------------------------------------ REST
if (args.url || args.fromRaw) {
  const rawDir = typeof args.fromRaw === "string" ? args.fromRaw : path.join(path.dirname(outDir), "_raw", "wordpress-rest");
  const src = new RestSource({ site: args.url || "offline", rawDir, offline: !!args.fromRaw && !args.url, onRetry: (s, ms) => console.error(`  HTTP ${s}, waiting ${Math.round(ms / 1000)}s`) });
  let disc;
  try { disc = await src.discover(); } catch (e) { die(e.message); }
  const R = { site: src.site, apiRoot: src.apiRoot === "rest_route" ? "?rest_route=" : "/wp-json", root: disc.root, plugins: pluginsFromNamespaces(disc.root?.namespaces), types: [], taxonomies: [] };
  for (const t of disc.types) {
    if (!t.rest_base) continue;
    const r = await src.get(`/${t.rest_namespace || "wp/v2"}/${t.rest_base}`, { per_page: 1 });
    const sample = Array.isArray(r.body) ? r.body[0] : null;
    R.types.push({ slug: t.slug, name: t.name, restBase: t.rest_base, hierarchical: t.hierarchical, taxonomies: t.taxonomies, total: r.total ?? (Array.isArray(r.body) ? r.body.length : null), status: r.status, exposes: sample ? { acf: sample.acf && !Array.isArray(sample.acf) ? Object.keys(sample.acf).length : sample.acf ? 0 : undefined, meta: sample.meta && !Array.isArray(sample.meta) ? Object.keys(sample.meta) : undefined, yoast: !!sample.yoast_head_json || undefined, rankMath: !!sample.rank_math_head || undefined, lang: sample.lang ?? undefined, contentRawAvailable: !!sample.content?.raw || undefined, elementor: /elementor/.test(sample.content?.rendered || "") || undefined } : undefined });
  }
  for (const t of disc.taxonomies) {
    if (!t.rest_base) continue;
    const r = await src.get(`/${t.rest_namespace || "wp/v2"}/${t.rest_base}`, { per_page: 1 });
    R.taxonomies.push({ slug: t.slug, name: t.name, restBase: t.rest_base, types: t.types, total: r.total ?? null, status: r.status });
  }
  const users = await src.get("/wp/v2/users", { per_page: 1 });
  R.users = { status: users.status, total: users.total ?? null };
  const menus = await src.get("/wp/v2/menus", { per_page: 1 });
  R.menus = { status: menus.status, exposed: menus.status === 200 };
  R.requests = src.requests;
  inv.inputs.rest = R;
  md.push("## REST API", "", `- ${R.site} (${R.apiRoot}) — "${preview(R.root?.name)}", timezone ${R.root?.timezone || "?"}, ${R.root?.namespaces?.length ?? 0} namespaces: ${(R.root?.namespaces || []).join(", ")}`, `- Plugins visible from namespaces: ${R.plugins.join(", ") || "none"}`, "", "| type | rest base | items | status | exposes |", "|---|---|---|---|---|");
  for (const t of R.types) md.push(`| ${t.slug} | ${t.restBase} | ${t.total ?? "?"} | ${t.status} | ${t.exposes ? Object.entries(t.exposes).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}${typeof v === "boolean" ? "" : ":" + (Array.isArray(v) ? v.join("/") : v)}`).join(", ") : t.status === 401 ? "needs auth" : ""} |`);
  md.push("", `- Taxonomies: ${R.taxonomies.map((t) => `${t.slug} (${t.total ?? "?"}${t.status !== 200 ? `, HTTP ${t.status}` : ""})`).join(", ")}`, `- Users endpoint: HTTP ${R.users.status}${R.users.total != null ? `, ${R.users.total} users` : ""}; menus endpoint: ${R.menus.exposed ? "exposed" : `HTTP ${R.menus.status} (not public)`}`, `- ${R.requests} HTTP requests made (raw responses cached in \`${rawDir}\`)`, "", "REST limits: only published content; `content.rendered` is post-processed HTML (no Gutenberg comments, shortcodes already expanded); ACF only when the field group has show_in_rest; custom post types only with show_in_rest.", "");
  lines.push(`rest: ${R.types.length} types (${R.types.filter((t) => t.status === 200).map((t) => `${t.slug}:${t.total}`).join(", ")}), plugins: ${R.plugins.join(", ") || "-"}, ${R.requests} requests`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "wp-inventory.json"), JSON.stringify(inv, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "wp-inventory.md"), md.join("\n") + "\n");
console.log("wordpress inventory:");
for (const l of lines) console.log("  " + l);
console.log(`  details: ${path.join(outDir, "wp-inventory.md")}`);
