#!/usr/bin/env node
// Inventory of a Ycode backup (.ycode): tables, collections + fields + item counts, assets, pages, locales,
// translations, components, settings KEY NAMES (never values). Writes content/_inventory/ycode-inventory.{json,md}.
//
// Usage:
//   node ycode-backup-inventory.mjs <backup.ycode> [--out content/_inventory] [--password-env YCODE_BACKUP_PASSWORD]
//
// The backup can hold secrets (AI provider API keys, integration tokens, page passwords) and personal data
// (form submissions). This tool prints and writes only structure, key names and counts.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/content-common.mjs";
import { readBackup, indexBackup, pagePath, dynamicPages, SECRET_SETTING_KEY, SENSITIVE_TABLES, UUID_RE } from "./lib/ycode-backup.mjs";

const HELP = `Usage: node ycode-backup-inventory.mjs <backup.ycode> [--out content/_inventory] [--password-env NAME]
  --out DIR            where to write ycode-inventory.json/.md (default content/_inventory)
  --password-env NAME  env var holding the backup password (only for encrypted "YCEN" backups)`;

const args = parseArgs();
if (args.help || !args._[0]) { console.log(HELP); process.exit(args.help ? 0 : 1); }
const file = args._[0];
if (!fs.existsSync(file)) die(`file not found: ${file}`);
const outDir = typeof args.out === "string" ? args.out : "content/_inventory";
const password = args.passwordEnv ? process.env[args.passwordEnv] : undefined;

let backup;
try { backup = readBackup(file, { password }); } catch (e) { die(e.message); }
const idx = indexBackup(backup, "published");
const { D } = idx;

const count = (rows = []) => ({ rows: rows.length, unique: new Set(rows.map((r) => r.id)).size, published: rows.filter((r) => r.is_published === true).length, draft: rows.filter((r) => r.is_published === false).length });
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// --- tables (names + counts only)
const tables = Object.fromEntries(Object.entries(D).map(([k, v]) => [k, Array.isArray(v) ? { ...count(v), sensitive: SENSITIVE_TABLES.has(k) || undefined } : { type: typeOf(v) }]));

// --- settings: key names, value types, secret flag. NEVER values.
const settings = (D.settings || []).map((s) => ({ key: s.key, valueType: typeOf(s.value), secret: SECRET_SETTING_KEY.test(s.key) || undefined, length: typeof s.value === "string" ? s.value.length : undefined }));
const secretKeysPresent = settings.filter((s) => s.secret && s.length !== 0).map((s) => s.key.replace(/:[0-9a-f-]{8,}$/i, ":<userId>"));
const secretFindings = [];
if (secretKeysPresent.length) secretFindings.push(`settings keys with secret-like names hold values: ${[...new Set(secretKeysPresent)].join(", ")}`);
if ((D.app_settings || []).length) secretFindings.push(`app_settings has ${D.app_settings.length} rows (integration tokens: Airtable/Webflow api_token, GitHub token…)`);
if ((D.webhooks || []).length) secretFindings.push(`webhooks has ${D.webhooks.length} rows (HMAC secrets)`);
if ((D.api_keys || []).length) secretFindings.push(`api_keys has ${D.api_keys.length} rows (hashes + prefixes)`);
const protectedPages = (D.pages || []).filter((p) => p.settings?.auth?.enabled && p.settings?.auth?.password).length + (D.page_folders || []).filter((p) => p.settings?.auth?.enabled && p.settings?.auth?.password).length;
if (protectedPages) secretFindings.push(`${protectedPages} page/folder rows have a plaintext password in settings.auth.password`);
if ((D.form_submissions || []).length) secretFindings.push(`form_submissions: ${D.form_submissions.length} rows of personal data (not exported)`);
if ((D.ai_chats || []).length) secretFindings.push(`ai_chats: ${D.ai_chats.length} chats (not exported)`);

// --- collections
const usedAssetIds = new Set();
const fieldList = [...idx.fields.values()].map((e) => e.pick);
const collections = [...idx.collections.values()].map(({ pick: c, published }) => {
  const fields = fieldList.filter((f) => f.collection_id === c.id).sort((a, b) => a.order - b.order).map((f) => ({
    name: f.name, key: f.key || undefined, type: f.type,
    reference: f.reference_collection_id ? idx.collections.get(f.reference_collection_id)?.pick?.name || f.reference_collection_id : undefined,
    multiple: f.data?.multiple || undefined,
    options: Array.isArray(f.data?.options) ? f.data.options.length : undefined,
    computed: f.is_computed || undefined, hidden: f.hidden || undefined, fillable: f.fillable, publishedOnlyInDraft: !idx.fields.get(f.id).published || undefined,
  }));
  const its = [...idx.items.values()].filter((e) => e.pick.collection_id === c.id);
  const assetFieldIds = new Set(fieldList.filter((f) => f.collection_id === c.id && ["image", "video", "audio", "document"].includes(f.type)).map((f) => f.id));
  for (const e of its) for (const ver of ["published", "draft"]) for (const [fid, v] of idx.values.get(e.pick.id)?.[ver] || []) {
    if (assetFieldIds.has(fid) && v) for (const id of String(v).match(UUID_RE) || []) usedAssetIds.add(id);
    else if (v && /assetId|"asset"/.test(v)) for (const id of String(v).match(UUID_RE) || []) usedAssetIds.add(id);
  }
  return {
    id: c.id, name: c.name, published: !!published, sorting: c.sorting ? { field: fieldList.find((f) => f.id === c.sorting.field)?.name || c.sorting.field, direction: c.sorting.direction } : null,
    items: { total: its.length, published: its.filter((e) => e.published).length, draftOnly: its.filter((e) => !e.published).length, notPublishable: its.filter((e) => e.pick.is_publishable === false).length },
    fields,
  };
});

// --- pages, components, layers: asset references
for (const t of ["page_layers", "components", "layer_styles", "settings"]) {
  for (const r of D[t] || []) {
    if (t === "settings" && SECRET_SETTING_KEY.test(r.key)) continue;
    const s = JSON.stringify(t === "settings" ? r.value : r);
    for (const id of s.match(UUID_RE) || []) usedAssetIds.add(id);
  }
}
const dyn = dynamicPages(idx);
const pages = [...idx.pages.values()].map(({ pick: p, published }) => ({
  name: p.name, path: pagePath(idx, p), published: !!published, index: p.is_index || undefined, dynamic: p.is_dynamic || undefined,
  collection: p.settings?.cms?.collection_id ? idx.collections.get(p.settings.cms.collection_id)?.pick?.name : undefined,
  errorPage: p.error_page || undefined, passwordProtected: p.settings?.auth?.enabled || undefined,
  seo: p.settings?.seo ? Object.keys(p.settings.seo).filter((k) => p.settings.seo[k]).join(",") || undefined : undefined,
  customCode: p.settings?.custom_code && (p.settings.custom_code.head || p.settings.custom_code.body) ? true : undefined,
})).sort((a, b) => a.path.localeCompare(b.path));

// --- assets
const assetRows = [...idx.assets.values()].map((e) => e.pick);
const byMime = {};
let totalBytes = 0;
for (const a of assetRows) { byMime[a.mime_type] = (byMime[a.mime_type] || 0) + 1; totalBytes += a.file_size || 0; }
const folders = new Map([...(D.asset_folders || [])].map((f) => [f.id, f.name]));
const assets = {
  unique: assetRows.length, byMime, totalBytes,
  withPublicUrl: assetRows.filter((a) => a.public_url).length,
  inlineSvgContent: assetRows.filter((a) => a.content && !a.storage_path).length,
  embeddedFiles: backup.files.length,
  embeddedFilesMatched: backup.files.filter((f) => assetRows.some((a) => a.storage_path === f.storagePath)).length,
  bySource: assetRows.reduce((m, a) => ((m[a.source] = (m[a.source] || 0) + 1), m), {}),
  byFolder: assetRows.reduce((m, a) => { const k = folders.get(a.asset_folder_id) || "(root)"; m[k] = (m[k] || 0) + 1; return m; }, {}),
  referenced: assetRows.filter((a) => usedAssetIds.has(a.id)).length,
  unreferenced: assetRows.filter((a) => !usedAssetIds.has(a.id)).map((a) => a.filename),
  largest: assetRows.filter((a) => a.file_size).sort((a, b) => b.file_size - a.file_size).slice(0, 5).map((a) => ({ filename: a.filename, bytes: a.file_size })),
};

// --- locales / translations
const translations = D.translations || [];
const locales = idx.locales.map((l) => ({ code: l.code, label: l.label, default: !!l.is_default, translations: translations.filter((t) => t.locale_id === l.id && t.is_published).length }));
const translationsBySource = translations.reduce((m, t) => ((m[t.source_type] = (m[t.source_type] || 0) + 1), m), {});

const inventory = {
  file: path.basename(file),
  backup: { ...backup._meta, manifest: { version: backup.manifest?.version, source: backup.manifest?.source, exportedAt: backup.manifest?.exportedAt, lastMigration: backup.manifest?.lastMigration, projectName: backup.manifest?.projectName, stats: backup.manifest?.stats } },
  tables, collections, pages, assets, locales, translationsBySource,
  components: [...new Map((D.components || []).map((c) => [c.id, c])).values()].map((c) => ({ name: c.name, variables: (c.variables || []).length, variants: (c.variants || []).length })),
  fonts: [...new Set((D.fonts || []).map((f) => `${f.family} (${f.type})`))],
  colorVariables: (D.color_variables || []).length,
  forms: { submissions: (D.form_submissions || []).length, forms: new Set((D.form_submissions || []).map((s) => s.form_id)).size },
  settings,
  secretFindings,
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "ycode-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");

const md = [];
md.push(`# Ycode backup inventory`, "", `- File: \`${inventory.file}\` (${inventory.backup.format}${inventory.backup.encrypted ? ", encrypted" : ""}, ${(inventory.backup.bytes / 1e6).toFixed(1)} MB JSON)`, `- Manifest: version ${inventory.backup.manifest.version}, source ${inventory.backup.manifest.source}, exported ${inventory.backup.manifest.exportedAt}, last migration ${inventory.backup.manifest.lastMigration}`, "");
md.push("## Secrets / personal data present (values NOT shown)", "", ...(secretFindings.length ? secretFindings.map((s) => `- ${s}`) : ["- none detected"]), "");
md.push("## Tables", "", "| table | rows | unique ids | published | draft |", "|---|---|---|---|---|");
for (const [k, v] of Object.entries(tables)) md.push(v.rows !== undefined ? `| ${k}${v.sensitive ? " (sensitive)" : ""} | ${v.rows} | ${v.unique} | ${v.published} | ${v.draft} |` : `| ${k} | (${v.type}) | | | |`);
md.push("", "## Collections", "");
for (const c of collections) {
  md.push(`### ${c.name}${c.published ? "" : " (never published)"}`, "", `Items: ${c.items.total} (published ${c.items.published}, draft-only ${c.items.draftOnly}, not publishable ${c.items.notPublishable})${c.sorting ? ` · sorted by ${c.sorting.field} ${c.sorting.direction}` : ""}`, "", "| field | key | type | notes |", "|---|---|---|---|");
  for (const f of c.fields) md.push(`| ${f.name} | ${f.key || ""} | ${f.type} | ${[f.reference && `→ ${f.reference}`, f.multiple && "multiple", f.options && `${f.options} options`, f.computed && "computed", f.hidden && "hidden", f.publishedOnlyInDraft && "draft-only field"].filter(Boolean).join(", ")} |`);
  md.push("");
}
md.push("## Pages", "", "| page | path | notes |", "|---|---|---|");
for (const p of pages) md.push(`| ${p.name} | \`${p.path}\` | ${[!p.published && "draft", p.index && "index", p.dynamic && `dynamic → ${p.collection || "?"}`, p.errorPage && `error ${p.errorPage}`, p.passwordProtected && "password-protected", p.seo && `seo: ${p.seo}`, p.customCode && "custom code"].filter(Boolean).join(", ")} |`);
md.push("", "## Assets", "", `- ${assets.unique} unique assets, ${(assets.totalBytes / 1e6).toFixed(1)} MB; with public URL ${assets.withPublicUrl}; inline SVG ${assets.inlineSvgContent}; embedded files ${assets.embeddedFiles} (matched ${assets.embeddedFilesMatched})`, `- By type: ${Object.entries(assets.byMime).map(([k, v]) => `${k} ${v}`).join(", ")}`, `- By folder: ${Object.entries(assets.byFolder).map(([k, v]) => `${k} ${v}`).join(", ")}`, `- Referenced somewhere (items, layers, components, settings): ${assets.referenced}; unreferenced: ${assets.unreferenced.length}`, `- Largest: ${assets.largest.map((a) => `${a.filename} (${(a.bytes / 1e6).toFixed(1)} MB)`).join(", ")}`, "");
md.push("## Locales", "", ...locales.map((l) => `- ${l.code} (${l.label})${l.default ? " default" : ""}: ${l.translations} published translations`), Object.keys(translationsBySource).length ? `- Translations by source: ${JSON.stringify(translationsBySource)}` : "- No translations table (single-language site)", "");
md.push("## Components", "", inventory.components.map((c) => c.name).join(", ") || "none", "", "## Settings keys (names only)", "", settings.map((s) => `\`${s.key.replace(/:[0-9a-f-]{8,}$/i, ":<userId>")}\`${s.secret ? " (secret)" : ""}`).join(", "), "");
fs.writeFileSync(path.join(outDir, "ycode-inventory.md"), md.join("\n") + "\n");

console.log(`ycode inventory: ${collections.length} collections, ${collections.reduce((n, c) => n + c.items.total, 0)} items, ${assets.unique} assets, ${pages.length} pages, ${locales.length} locale(s)`);
for (const c of collections) console.log(`  ${c.name}: ${c.items.total} items (${c.items.published} published), ${c.fields.length} fields`);
if (secretFindings.length) console.log(`  WARNING: backup contains secrets/PII (${secretFindings.length} findings, values not shown). Do not commit the .ycode file.`);
console.log(`  details: ${path.join(outDir, "ycode-inventory.md")}`);
