// Reader for Ycode project backups (.ycode). Format: see ../../references/backup-format.md.
//   plain:     gzip(JSON {manifest, data:{<table>: rows[]}, files:[{storagePath, base64, mimeType}]})
//   encrypted: "YCEN" + salt(16) + iv(12) + authTag(16) + AES-256-GCM(gzip(JSON)), key = scrypt(password, salt, 32)
// Never print values from settings/app_settings/webhooks/api_keys/form_submissions/ai_chats: they hold secrets or PII.
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

/** Keys/tables whose VALUES must never be printed or exported. */
export const SECRET_SETTING_KEY = /api_key|apikey|token|secret|password|passwd|private|credential|custom_code|verification/i;
export const SENSITIVE_TABLES = new Set(["app_settings", "webhooks", "webhook_deliveries", "api_keys", "form_submissions", "ai_chats", "versions"]);

export function readBackup(file, { password } = {}) {
  let buf = fs.readFileSync(file);
  let encrypted = false;
  if (buf.subarray(0, 4).toString("latin1") === "YCEN") {
    encrypted = true;
    if (!password) throw new Error("this backup is password-encrypted (YCEN header). Put the password in an env var and pass --password-env NAME.");
    const salt = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(32, 48), ct = buf.subarray(48);
    const key = crypto.scryptSync(password, salt, 32);
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    try { buf = Buffer.concat([d.update(ct), d.final()]); } catch { throw new Error("could not decrypt the backup (wrong password?)"); }
  }
  let format = "json";
  if (buf[0] === 0x1f && buf[1] === 0x8b) { buf = zlib.gunzipSync(buf); format = "gzip+json"; }
  if (buf[0] === 0x50 && buf[1] === 0x4b) throw new Error("this file is a zip archive, not a Ycode backup. Unzip it and pass the .ycode file inside.");
  const first = buf.subarray(0, 64).toString("utf8").trimStart()[0];
  if (first !== "{") throw new Error("unrecognized backup format (expected gzip or JSON)");
  const json = JSON.parse(buf.toString("utf8"));
  if (!json.data || typeof json.data !== "object") throw new Error("backup JSON has no `data` object");
  return { ...json, files: json.files || [], _meta: { encrypted, format, bytes: buf.length } };
}

/**
 * Ycode tables use a composite key (id, is_published): a row can exist as draft, published, or both.
 * Returns Map(id -> { published?, draft?, pick }) where pick follows `prefer` ("published" | "draft").
 */
export function versions(rows = [], prefer = "published") {
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.id) || {};
    if (r.is_published) e.published = r; else e.draft = r;
    m.set(r.id, e);
  }
  for (const e of m.values()) e.pick = prefer === "draft" ? e.draft || e.published : e.published || e.draft;
  return m;
}

/** Builds lookups used by inventory and export. */
export function indexBackup(backup, prefer = "published") {
  const D = backup.data;
  const collections = versions(D.collections, prefer);
  const fields = versions(D.collection_fields, prefer);
  const items = versions(D.collection_items, prefer);
  const assets = versions(D.assets, "published");
  const pages = versions(D.pages, prefer);
  const folders = versions(D.page_folders, prefer);
  const locales = [...versions(D.locales, "published").values()].map((e) => e.pick);
  const defaultLocale = locales.find((l) => l.is_default) || locales[0] || null;
  // values: item_id -> { published: Map(field_id -> value), draft: Map }
  const values = new Map();
  for (const v of D.collection_item_values || []) {
    const e = values.get(v.item_id) || { published: new Map(), draft: new Map() };
    (v.is_published ? e.published : e.draft).set(v.field_id, v.value);
    values.set(v.item_id, e);
  }
  const fileByPath = new Map((backup.files || []).map((f) => [f.storagePath, f]));
  return { D, collections, fields, items, assets, pages, folders, locales, defaultLocale, values, fileByPath };
}

/** "/folder/sub" for a page folder chain (by page_folder_id), using picked versions. */
export function folderPath(idx, folderId, slugOf = (f) => f.slug) {
  const parts = [];
  let guard = 0;
  while (folderId && guard++ < 50) {
    const f = idx.folders.get(folderId)?.pick;
    if (!f) break;
    if (f.slug) parts.unshift(slugOf(f));
    folderId = f.page_folder_id;
  }
  return parts.length ? "/" + parts.join("/") : "";
}

/** Public path of a static page ("/" for the homepage). Dynamic pages return the template with ":slug". */
export function pagePath(idx, page) {
  const base = folderPath(idx, page.page_folder_id);
  if (page.is_dynamic) return `${base}/:slug`;
  if (page.is_index || !page.slug) return base || "/";
  return `${base}/${page.slug}`;
}

/** Collection id -> dynamic page (first by order) that renders its items. */
export function dynamicPages(idx) {
  const out = new Map();
  const pages = [...idx.pages.values()].map((e) => e.pick).filter((p) => p.is_dynamic && p.settings?.cms?.collection_id).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || (a.order ?? 0) - (b.order ?? 0));
  for (const p of pages) {
    const list = out.get(p.settings.cms.collection_id) || [];
    list.push(p);
    out.set(p.settings.cms.collection_id, list);
  }
  return out;
}

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
