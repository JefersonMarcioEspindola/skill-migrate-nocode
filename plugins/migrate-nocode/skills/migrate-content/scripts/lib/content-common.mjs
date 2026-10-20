// Shared helpers for the CMS content exporters (normalized format v1, see migrate-content/references/content-format.md).
// Zero dependencies (Node >= 18). Byte-identical copies live in migrate-{ycode,webflow,framer,wordpress}/scripts/lib/.
// Edit the canonical file in migrate-content/scripts/lib/ and copy it over the others.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FORMAT_VERSION = 1;
export const FIELD_TYPES = ["text", "richtext", "number", "boolean", "date", "image", "file", "reference", "multi-reference", "option", "link", "color", "json"];

// ---------------------------------------------------------------- CLI

/** Parses argv into { _: positionals, key: value|true }. Supports --k v, --k=v, --flag, --no-flag. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { out.help = true; continue; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > -1) { out[camel(a.slice(2, eq))] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (key.startsWith("no-")) { out[camel(key.slice(3))] = false; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[camel(key)] = next; i++; } else out[camel(key)] = true;
  }
  return out;
}
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export const listOpt = (v) => (v === undefined || v === true || v === false ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));

/** "post=/blog/:slug,page=/:path" -> { post: "/blog/:slug", page: "/:path" } */
export function parseRoutes(v) {
  const out = {};
  for (const part of listOpt(v)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Fills a route template. Tokens: :slug :id :locale :path :yyyy :mm :dd */
export function fillRoute(tpl, item) {
  const d = item.publishedAt ? new Date(item.publishedAt) : null;
  const pad = (n) => String(n).padStart(2, "0");
  let p = tpl
    .replace(/:slug\b/g, item.slug ?? "")
    .replace(/:id\b/g, item.id ?? "")
    .replace(/:path\b/g, (item.path ?? item.slug ?? "").replace(/^\/+/, ""))
    .replace(/:locale\b/g, item.locale ?? "")
    .replace(/:yyyy\b/g, d ? String(d.getUTCFullYear()) : "")
    .replace(/:mm\b/g, d ? pad(d.getUTCMonth() + 1) : "")
    .replace(/:dd\b/g, d ? pad(d.getUTCDate()) : "");
  p = ("/" + p).replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/$/, "") : p;
}

export const isDirectRun = (metaUrl) => !!process.argv[1] && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;

export function die(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------- strings

export function slugify(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** "Cover Image" / "cover-image" / "cover_image" -> "coverImage". Always a valid JS identifier. */
export function toFieldName(s) {
  const words = String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let n = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
  if (!n) n = "field";
  if (/^[0-9]/.test(n)) n = "_" + n;
  return n;
}

/** Returns a name not in `used` (adds it). */
export function uniqueName(used, name) {
  let n = name, i = 2;
  while (used.has(n)) n = `${name}${i++}`;
  used.add(n);
  return n;
}

export const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", middot: "·", bull: "•" };
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const stripTags = (html) => decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Short preview for reports, never used for secrets. */
export const preview = (s, n = 60) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// ---------------------------------------------------------------- dates / values

/**
 * Normalizes a date-ish value to ISO 8601. Date-only inputs (2024-01-31, 20240131) stay YYYY-MM-DD.
 * Accepts epoch seconds/ms, "YYYY-MM-DD HH:MM:SS" (treated as UTC unless tz given), JS Date.toString() strings.
 */
export function toISODate(v, { assumeUTC = true } = {}) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (typeof v === "number") return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  let s = String(v).trim();
  if (/^0000-00-00/.test(s)) return null;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{10}$|^\d{13}$/.test(s)) return toISODate(Number(s));
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + (assumeUTC ? "Z" : "");
  s = s.replace(/\s*\([^)]*\)\s*$/, ""); // "… GMT+0000 (Coordinated Universal Time)"
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(/,(?=\d{3}\b)/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function toBoolean(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y", "sim"].includes(s)) return true;
  if (["0", "false", "no", "off", "n", "não", "nao"].includes(s)) return false;
  return null;
}

export const isUrlLike = (s) => typeof s === "string" && /^(https?:)?\/\//i.test(s.trim());

// ---------------------------------------------------------------- HTML sanitizer

const KEEP = new Set("p h1 h2 h3 h4 h5 h6 a strong b em i u s del ins sup sub small mark code pre kbd br hr blockquote q cite ul ol li dl dt dd figure figcaption img picture source video audio iframe table thead tbody tfoot tr th td caption span div".split(" "));
const DROP_WITH_CONTENT = new Set("script style noscript template object embed form input button select textarea svg math head title meta link".split(" "));
const VOID = new Set("br hr img source wbr input meta link col area param track embed".split(" "));
const GLOBAL_ATTRS = new Set(["id", "dir", "lang"]);
const TAG_ATTRS = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "srcset", "sizes", "loading"],
  source: ["src", "srcset", "type", "media"],
  video: ["src", "controls", "poster", "loop", "muted", "playsinline", "width", "height"],
  audio: ["src", "controls", "loop"],
  iframe: ["src", "title", "width", "height", "allow", "allowfullscreen"],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  ol: ["start", "reversed", "type"],
  blockquote: ["cite"],
  q: ["cite"],
  code: ["class"],
  pre: ["class"],
};
const URL_ATTRS = new Set(["href", "src", "poster", "cite"]);
const IFRAME_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|player\.vimeo\.com|loom\.com|spotify\.com|google\.com|wistia\.(com|net)|vidyard\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|codepen\.io|figma\.com)$/i;

function safeUrl(v, tag) {
  const s = decodeEntities(v).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (/^(javascript|vbscript|file):/i.test(s.replace(/\s/g, ""))) return null;
  if (/^data:/i.test(s)) return tag === "img" && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(s) ? s : null;
  return s;
}

function parseAttrs(src) {
  const attrs = [];
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ""]);
  return attrs;
}

/**
 * Allowlist HTML sanitizer (see content-format.md "Rich text"). Returns { html, removed } where removed counts
 * dropped tags/attrs (for the report). Not a browser-grade parser, but output is balanced and safe to render.
 * opts.baseUrl: makes relative src/href absolute (e.g. Ycode "/a/…" images). opts.onUrl(url, tag, attrs): asset hook.
 */
export function sanitizeHtml(input, opts = {}) {
  const html = String(input ?? "");
  const removed = {};
  const bump = (k) => (removed[k] = (removed[k] || 0) + 1);
  const out = [];
  const stack = [];
  let dropDepth = 0, dropTag = null;
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m;
  const text = (t) => { if (!dropDepth && t) out.push(escapeHtml(decodeEntities(t))); };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    const raw = m[0];
    if (!m[1]) { if (raw.startsWith("<!--")) bump("comment"); continue; }
    const tag = m[1].toLowerCase();
    const closing = raw[1] === "/";
    if (dropDepth) {
      if (tag === dropTag) dropDepth += closing ? -1 : raw.endsWith("/>") ? 0 : 1;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      bump(`<${tag}>`);
      if (!closing && !VOID.has(tag) && !raw.endsWith("/>")) { dropDepth = 1; dropTag = tag; }
      continue;
    }
    if (!KEEP.has(tag)) { if (!closing) bump(`<${tag}>`); continue; }
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
      continue;
    }
    const allowed = new Set([...(TAG_ATTRS[tag] || []), ...GLOBAL_ATTRS]);
    const kept = [];
    let dropElement = false;
    for (let [k, v] of parseAttrs(m[2] || "")) {
      if (!allowed.has(k)) { bump(k.startsWith("on") ? "on*" : k.startsWith("data-") ? "data-*" : k); continue; }
      if (k === "class") { const langs = v.split(/\s+/).filter((c) => /^language-[\w+-]+$/.test(c)); if (!langs.length) continue; v = langs.join(" "); }
      if (URL_ATTRS.has(k)) {
        let u = safeUrl(v, tag);
        if (u === null) { bump(`unsafe ${k}`); if (tag === "iframe" || tag === "img") dropElement = true; continue; }
        if (opts.baseUrl && /^\/(?!\/)/.test(u)) u = new URL(u, opts.baseUrl).href;
        if (tag === "iframe") { let host = ""; try { host = new URL(u, "https://x.invalid").host; } catch {} if (!/^https:/i.test(u) || !IFRAME_HOSTS.test(host)) { dropElement = true; bump("iframe (host not allowed)"); continue; } }
        v = u;
        if (opts.onUrl && (k === "src" || k === "poster")) opts.onUrl(u, tag, Object.fromEntries(parseAttrs(m[2] || "")));
      }
      if (k === "srcset") v = v.split(",").map((part) => { const [u0, d] = part.trim().split(/\s+/); const u = safeUrl(u0 || "", tag); return u ? (d ? `${u} ${d}` : u) : null; }).filter(Boolean).join(", ");
      if (k === "target" && v !== "_blank") continue;
      kept.push(v === "" && ["controls", "loop", "muted", "playsinline", "allowfullscreen", "reversed"].includes(k) ? k : `${k}="${escapeAttr(decodeEntities(v))}"`);
    }
    if (dropElement) { if (!VOID.has(tag) && !raw.endsWith("/>")) { dropDepth = 1; dropTag = tag; } continue; }
    if (tag === "a" && kept.some((a) => a.startsWith('target="_blank"')) && !kept.some((a) => a.startsWith("rel="))) kept.push('rel="noopener noreferrer"');
    out.push(`<${tag}${kept.length ? " " + kept.join(" ") : ""}>`);
    if (!VOID.has(tag)) {
      if (raw.endsWith("/>")) out.push(`</${tag}>`); else stack.push(tag);
    }
  }
  text(html.slice(last));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return { html: out.join("").replace(/<(p|span|div)>\s*<\/\1>/g, "").trim(), removed };
}

/** Builds the normalized rich text value. */
export function richText(rawValue, html, rawFormat, opts = {}) {
  const s = sanitizeHtml(html, opts);
  return { value: { html: s.html, raw: rawValue, rawFormat }, removed: s.removed };
}

/** Finds [shortcode] names in WordPress-ish content (ignores escaped [[x]]). */
export function findShortcodes(text) {
  const names = new Map();
  const re = /(?<!\[)\[(?!\[)\/?([a-zA-Z][\w-]*)(?=[\s\]\/])[^\]]*\](?!\])/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) if (!m[0].startsWith("[/")) names.set(m[1], (names.get(m[1]) || 0) + 1);
  return names;
}

// ---------------------------------------------------------------- CSV (RFC 4180)

/** Parses CSV text into rows (arrays of strings). Handles quotes, escaped quotes, CRLF and newlines in quotes, BOM. */
export function parseCsv(text, delimiter) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!delimiter) {
    const firstLine = s.slice(0, s.indexOf("\n") === -1 ? s.length : s.indexOf("\n"));
    const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length]);
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { inQ = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

export function csvObjects(text) {
  const rows = parseCsv(text);
  const header = (rows.shift() || []).map((h) => h.trim());
  return { header, records: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

/** Infers a normalized field type from sample string values (CSV sources). */
export function inferType(values, hint = "") {
  const vals = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "").map(String);
  const h = hint.toLowerCase();
  if (!vals.length) return "text";
  const all = (fn) => vals.every(fn);
  if (all((v) => /^(true|false)$/i.test(v))) return "boolean";
  if (all((v) => /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^rgba?\(/i.test(v))) return "color";
  if (all((v) => /^-?\d+(\.\d+)?$/.test(v)) && !/slug|id$|phone|zip|cep/.test(h)) return "number";
  if (all((v) => /<\/?(p|h[1-6]|ul|ol|li|strong|em|a|br|div|figure|img|blockquote)\b/i.test(v))) return "richtext";
  const isImg = (v) => v.split(/\s*[;,]\s*/).filter(Boolean).every((u) => isUrlLike(u) && /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(u) || /framerusercontent\.com\/images\//.test(u));
  if (all(isImg)) return "image";
  if (all((v) => isUrlLike(v) && /\.(pdf|zip|docx?|xlsx?|pptx?|mp4|mov|webm|mp3|wav|csv|txt)(\?|$)/i.test(v))) return "file";
  if (all((v) => isUrlLike(v) || /^mailto:|^tel:/i.test(v))) return "link";
  if (all((v) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{2} \d{4} /.test(v))) return "date";
  return "text";
}

// ---------------------------------------------------------------- HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + JSON with retries: 429 honours Retry-After (or exponential backoff), 5xx/network errors retry.
 * `minIntervalMs` spaces requests (e.g. 1000 for 60/min). Never logs headers (they may contain tokens).
 */
export function makeClient({ headers = {}, minIntervalMs = 0, retries = 5, userAgent = "migrate-nocode-content/1.0", onRetry } = {}) {
  let lastAt = 0;
  return async function request(url, { method = "GET", accept = "application/json" } = {}) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      let res;
      try {
        res = await fetch(url, { method, headers: { accept, "user-agent": userAgent, ...headers } });
      } catch (e) {
        if (attempt >= retries) throw new Error(`network error for ${redactUrl(url)}: ${e.message}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retries) throw new Error(`HTTP ${res.status} for ${redactUrl(url)} after ${retries} retries`);
        const ra = Number(res.headers.get("retry-after"));
        const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 1000 * 2 ** attempt);
        onRetry?.(res.status, ms);
        await res.arrayBuffer().catch(() => {});
        await sleep(ms);
        continue;
      }
      const body = method === "HEAD" ? "" : await res.text();
      let json = null;
      if (body && /json/i.test(res.headers.get("content-type") || "")) { try { json = JSON.parse(body); } catch {} }
      else if (body && /^\s*[\[{]/.test(body)) { try { json = JSON.parse(body); } catch {} }
      return { status: res.status, ok: res.ok, headers: res.headers, json, text: body };
    }
  };
}

/** Removes query params that look like credentials before a URL is shown anywhere. */
export function redactUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (/token|key|secret|pass|auth|sig/i.test(k)) url.searchParams.set(k, "REDACTED");
    url.username = ""; url.password = "";
    return url.href;
  } catch { return String(u).replace(/(token|key|secret|password)=[^&]+/gi, "$1=REDACTED"); }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------------------------------------------------------------- writer

/**
 * Accumulates collections, assets, redirects and warnings, then writes the content/ folder.
 *   const w = new ContentWriter({ outDir: "content", platform: "ycode", tool: "ycode-export.mjs" });
 *   w.addCollection({...}); w.asset({url,…}, {collection,item,field}); w.redirect({from,to,…}); w.warn("x", "detail"); w.write();
 */
export class ContentWriter {
  constructor({ outDir = "content", platform, tool, merge = true } = {}) {
    Object.assign(this, { outDir, platform, tool, merge });
    this.collections = [];
    this.assets = new Map();
    this.redirects = new Map();
    this.warnings = new Map();
    this.notes = [];
    this.unknownTypes = new Map();
    this.exportedAt = new Date().toISOString();
  }

  addCollection(c) {
    const col = {
      formatVersion: FORMAT_VERSION,
      collection: c.collection,
      label: c.label ?? c.collection,
      ...(c.titleField ? { titleField: c.titleField } : {}),
      source: { platform: this.platform, ref: c.ref ?? c.collection, exportedAt: this.exportedAt, tool: this.tool, ...(c.sourceExtra || {}) },
      fields: c.fields,
      items: c.items,
    };
    this.collections.push(col);
    return col;
  }

  /** Registers an asset (dedup by url, then sourceId) and a usage. Returns the normalized asset. */
  asset(a, usage) {
    if (!a || (!a.url && !a.sourceId && !a.localFile)) return null;
    const key = a.url || `id:${a.sourceId}`;
    let cur = this.assets.get(key);
    if (!cur) { cur = { url: a.url ?? null, usedBy: [] }; this.assets.set(key, cur); }
    for (const k of ["sourceId", "filename", "mime", "size", "width", "height", "alt", "localFile"]) if (a[k] !== undefined && a[k] !== null && a[k] !== "" && cur[k] === undefined) cur[k] = a[k];
    if (a.unused && !cur.usedBy.length) cur.unused = true;
    if (usage) {
      delete cur.unused;
      if (!cur.usedBy.some((u) => u.collection === usage.collection && u.item === usage.item && u.field === usage.field)) cur.usedBy.push({ inline: false, ...usage });
    }
    return cur;
  }

  redirect(r) {
    if (!r.from || !r.to || r.from === r.to) return;
    if (!this.redirects.has(r.from)) this.redirects.set(r.from, { status: 301, confidence: "high", ...r });
  }

  warn(kind, detail) {
    const w = this.warnings.get(kind) || { count: 0, examples: [] };
    w.count++;
    if (detail !== undefined && w.examples.length < 8) w.examples.push(String(detail));
    this.warnings.set(kind, w);
  }

  note(s) { this.notes.push(s); }

  unknownType(type, where) {
    const u = this.unknownTypes.get(type) || [];
    if (u.length < 8) u.push(where);
    this.unknownTypes.set(type, u);
  }

  write({ extraReport = "" } = {}) {
    fs.mkdirSync(this.outDir, { recursive: true });
    for (const c of this.collections) fs.writeFileSync(path.join(this.outDir, `${c.collection}.json`), JSON.stringify(c, null, 2) + "\n");

    // assets: merge with an existing file (other runs), dedup by url/sourceId
    const assetsFile = path.join(this.outDir, "_assets.json");
    let assets = [...this.assets.values()];
    if (this.merge && fs.existsSync(assetsFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(assetsFile, "utf8")).assets || [];
        const mine = new Set(this.collections.map((c) => c.collection));
        const keyOf = (a) => a.url || `id:${a.sourceId}`;
        const have = new Map(assets.map((a) => [keyOf(a), a]));
        for (const p of prev) {
          const usedBy = (p.usedBy || []).filter((u) => !mine.has(u.collection));
          const cur = have.get(keyOf(p));
          if (cur) cur.usedBy.push(...usedBy.filter((u) => !cur.usedBy.some((x) => x.collection === u.collection && x.item === u.item && x.field === u.field)));
          else if (usedBy.length || p.unused) assets.push({ ...p, usedBy });
        }
      } catch {}
    }
    assets.sort((a, b) => String(a.url ?? a.sourceId).localeCompare(String(b.url ?? b.sourceId)));
    fs.writeFileSync(assetsFile, JSON.stringify({ formatVersion: FORMAT_VERSION, assets }, null, 2) + "\n");

    const redirFile = path.join(this.outDir, "_redirects.json");
    let redirects = [...this.redirects.values()];
    if (this.merge && fs.existsSync(redirFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(redirFile, "utf8")).redirects || [];
        const mine = new Set(this.collections.map((c) => c.collection));
        const have = new Set(redirects.map((r) => r.from));
        for (const p of prev) if (!have.has(p.from) && !mine.has(p.collection)) redirects.push(p);
      } catch {}
    }
    redirects.sort((a, b) => a.from.localeCompare(b.from));
    fs.writeFileSync(redirFile, JSON.stringify({ formatVersion: FORMAT_VERSION, redirects }, null, 2) + "\n");

    const report = this.report(assets, redirects) + (extraReport ? `\n${extraReport.trim()}\n` : "");
    fs.writeFileSync(path.join(this.outDir, "_report.md"), report);
    return { assets: assets.length, redirects: redirects.length };
  }

  report(assets, redirects) {
    const L = [];
    L.push(`# Content export report`, "", `- Tool: \`${this.tool}\` (platform: ${this.platform})`, `- Exported at: ${this.exportedAt}`, `- Output: \`${this.outDir}/\``, "");
    L.push("## Collections", "", "| collection | label | items | published | draft | locales | fields |", "|---|---|---|---|---|---|---|");
    for (const c of this.collections) {
      const pub = c.items.filter((i) => i.status === "published").length;
      const locales = [...new Set(c.items.map((i) => i.locale).filter(Boolean))];
      const types = Object.entries(c.fields.reduce((m, f) => ((m[f.type] = (m[f.type] || 0) + 1), m), {})).map(([t, n]) => `${t}×${n}`).join(", ");
      L.push(`| ${c.collection} | ${String(c.label).replace(/\|/g, "/")} | ${c.items.length} | ${pub} | ${c.items.length - pub} | ${locales.join(", ") || "-"} | ${types} |`);
    }
    L.push("", `Assets referenced: ${assets.length} (inline in rich text: ${assets.filter((a) => a.usedBy?.some((u) => u.inline)).length}, unused library assets: ${assets.filter((a) => a.unused).length}). Redirect candidates: ${redirects.length}.`, "");
    L.push("## Unknown field types", "");
    if (!this.unknownTypes.size) L.push("None.");
    for (const [t, where] of this.unknownTypes) L.push(`- \`${t}\` → exported as \`json\` (${where.join("; ")})`);
    L.push("", "## Warnings", "");
    if (!this.warnings.size) L.push("None.");
    for (const [k, w] of this.warnings) {
      L.push(`- **${k}** ×${w.count}`);
      for (const e of w.examples) L.push(`  - ${e}`);
    }
    if (this.notes.length) L.push("", "## Notes", "", ...this.notes.map((n) => `- ${n}`));
    try {
      const mine = new Set(this.collections.map((c) => `${c.collection}.json`));
      const others = fs.readdirSync(this.outDir).filter((f) => f.endsWith(".json") && !f.startsWith("_") && !mine.has(f));
      if (others.length) L.push("", "## Other collection files already in this folder (from earlier runs)", "", ...others.map((f) => `- ${f}`));
    } catch {}
    return L.join("\n") + "\n";
  }

  summary() {
    return this.collections.map((c) => `  ${c.collection}: ${c.items.length} items, ${c.fields.length} fields`).join("\n");
  }
}
