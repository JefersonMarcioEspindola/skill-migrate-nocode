// Helpers shared by the capture tools (snapshot, detect, assets, tojsx, head-check, gen-meta).
// Nothing here reads migrate.config.json at import time, so detect.mjs can use it before a config exists.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "parse5";
import { config, mirrorPath } from "./common.mjs";

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const sha1 = (s, n = 10) => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);
export const today = () => new Date().toISOString().slice(0, 10);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTML (parse5)

/** Parses like a browser with scripting on (so <noscript> content is raw text, as in the live DOM). */
export const parseHtml = (html) => parse(html, { scriptingEnabled: true });

/** Depth-first walk. `template: false` skips <template> content; `foreign: false` does not descend into svg/math. */
export function* walk(node, opts = {}) {
  yield node;
  if (opts.foreign === false && node.namespaceURI && node.namespaceURI !== HTML_NS) return;
  const kids = node.tagName === "template" ? (opts.template === false ? null : node.content?.childNodes) : node.childNodes;
  for (const c of kids || []) yield* walk(c, opts);
}
export const elements = (root, opts) => [...walk(root, opts)].filter((n) => n.tagName);

const fullName = (a) => (a.prefix ? `${a.prefix}:${a.name}` : a.name);
export const attr = (n, name) => n?.attrs?.find((a) => fullName(a) === name)?.value;
export const attrMap = (n) => Object.fromEntries((n?.attrs || []).map((a) => [fullName(a), a.value]));
export const classList = (n) => (attr(n, "class") || "").split(/\s+/).filter(Boolean);
export const childrenOf = (n) => (n.tagName === "template" ? n.content?.childNodes : n.childNodes) || [];
export const textOf = (n) => (n.nodeName === "#text" ? n.value : childrenOf(n).map(textOf).join(""));
export const parentEl = (n) => (n.parentNode && n.parentNode.tagName ? n.parentNode : null);

/** Opening tag of an element as text (for summaries), e.g. <div id="x" class="a b">. */
export function openTag(n, max = 200) {
  const s = `<${n.tagName}${(n.attrs || []).map((a) => ` ${fullName(a)}="${a.value}"`).join("")}>`;
  return s.length > max ? s.slice(0, max - 4) + "...>" : s;
}

// ---------------------------------------------------------------- tiny CSS selector engine (for rootSelector)
// Supports: tag, *, #id, .class, [attr], [attr=v], [attr~=v], [attr^=v], [attr$=v], [attr*=v], [attr|=v],
// combinators " ", ">", "+", "~" and comma lists. Pseudo-classes are not supported (an error is thrown).

function parseCompound(s) {
  const c = { tag: null, ids: [], classes: [], attrs: [] };
  let i = 0;
  const m = s.match(/^(\*|[a-zA-Z][\w-]*)/);
  if (m) { c.tag = m[1] === "*" ? null : m[1].toLowerCase(); i = m[1].length; }
  while (i < s.length) {
    const ch = s[i];
    if (ch === "#" || ch === ".") {
      const mm = s.slice(i + 1).match(/^(?:\\.|[\w-])+/);
      if (!mm) throw new Error(`Bad selector near "${s.slice(i)}"`);
      const v = mm[0].replace(/\\(.)/g, "$1");
      (ch === "#" ? c.ids : c.classes).push(v);
      i += 1 + mm[0].length;
    } else if (ch === "[") {
      const end = s.indexOf("]", i);
      const body = s.slice(i + 1, end).trim();
      const am = body.match(/^([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*(i)?)?$/);
      if (!am) throw new Error(`Bad attribute selector [${body}]`);
      c.attrs.push({ name: am[1].toLowerCase(), op: am[2] || null, value: am[3] ?? am[4] ?? am[5] ?? "", ci: !!am[6] });
      i = end + 1;
    } else if (ch === ":") {
      throw new Error(`Pseudo-classes are not supported in rootSelector ("${s}"); use an id, class or attribute.`);
    } else throw new Error(`Bad selector near "${s.slice(i)}"`);
  }
  return c;
}

function parseComplex(sel) {
  const parts = [];
  let buf = "", pending = null, depth = 0, q = null;
  const flush = () => {
    const t = buf.trim();
    if (t) { parts.push({ comb: parts.length ? pending || " " : null, compound: parseCompound(t) }); pending = null; }
    buf = "";
  };
  for (const ch of sel) {
    if (q) { buf += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) { flush(); if (!/\s/.test(ch)) pending = ch; continue; }
    buf += ch;
  }
  flush();
  return parts;
}

function matchCompound(n, c) {
  if (!n.tagName) return false;
  if (c.tag && n.tagName.toLowerCase() !== c.tag) return false;
  if (c.ids.length && !c.ids.every((id) => attr(n, "id") === id)) return false;
  if (c.classes.length) { const cl = new Set(classList(n)); if (!c.classes.every((x) => cl.has(x))) return false; }
  for (const a of c.attrs) {
    let v = attr(n, a.name);
    if (v === undefined) return false;
    if (!a.op) continue;
    let w = a.value;
    if (a.ci) { v = v.toLowerCase(); w = w.toLowerCase(); }
    const ok = { "=": v === w, "~=": v.split(/\s+/).includes(w), "^=": v.startsWith(w), "$=": v.endsWith(w), "*=": v.includes(w), "|=": v === w || v.startsWith(w + "-") }[a.op];
    if (!ok) return false;
  }
  return true;
}

const prevEl = (n) => { const sib = n.parentNode?.childNodes || []; for (let i = sib.indexOf(n) - 1; i >= 0; i--) if (sib[i].tagName) return sib[i]; return null; };

function matchComplex(n, parts, i) {
  if (!matchCompound(n, parts[i].compound)) return false;
  if (i === 0) return true;
  const comb = parts[i].comb;
  if (comb === ">") { const p = parentEl(n); return !!p && matchComplex(p, parts, i - 1); }
  if (comb === "+") { const s = prevEl(n); return !!s && matchComplex(s, parts, i - 1); }
  if (comb === "~") { for (let s = prevEl(n); s; s = prevEl(s)) if (matchComplex(s, parts, i - 1)) return true; return false; }
  for (let p = parentEl(n); p; p = parentEl(p)) if (matchComplex(p, parts, i - 1)) return true;
  return false;
}

export function querySelectorAll(root, selector) {
  const alts = selector.split(",").map((s) => parseComplex(s.trim())).filter((p) => p.length);
  return elements(root, { template: false }).filter((n) => alts.some((p) => matchComplex(n, p, p.length - 1)));
}
export const querySelector = (root, selector) => querySelectorAll(root, selector)[0] || null;

/** A CSS path that identifies a node in its document (for reports). */
export function cssPath(n) {
  const out = [];
  for (let x = n; x && x.tagName && x.tagName !== "html"; x = parentEl(x)) {
    const id = attr(x, "id");
    if (id && /^[A-Za-z][\w-]*$/.test(id)) { out.unshift(`#${id}`); break; }
    const sib = (x.parentNode?.childNodes || []).filter((s) => s.tagName === x.tagName);
    out.unshift(sib.length > 1 ? `${x.tagName}:nth-of-type(${sib.indexOf(x) + 1})` : x.tagName);
  }
  return out.join(" > ");
}

// ---------------------------------------------------------------- sections (children of rootSelector)

/** Root children that are not sections: they belong to head/runtime capture, never to the page markup. */
export const NON_SECTION_TAGS = new Set(["script", "noscript", "link", "meta", "template", "base", "title"]);

export const sectionNodes = (root) => childrenOf(root).filter((n) => n.tagName && !NON_SECTION_TAGS.has(n.tagName));
export const skippedRootNodes = (root) => childrenOf(root).filter((n) => n.tagName && NON_SECTION_TAGS.has(n.tagName));

export function sectionSummary(n, index, idAttribute) {
  const s = { index, tag: n.tagName, id: attr(n, "id") || null, classes: classList(n) };
  if (idAttribute && idAttribute !== "id") s[idAttribute] = attr(n, idAttribute) ?? null;
  s.text = textOf(n).replace(/\s+/g, " ").trim().slice(0, 80);
  s.elements = elements(n).length;
  return s;
}

// ---------------------------------------------------------------- URLs

/** Undoes the escapes seen in HTML/JSON/RSC payloads: &amp; & \/ /. */
export function cleanUrl(u) {
  return String(u).trim()
    .replace(/\\u0026/gi, "&").replace(/\\u002f/gi, "/").replace(/\\\//g, "/")
    .replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&#x2F;/gi, "/").replace(/&quot;$/, "");
}

/** Absolute http(s) URL without the #hash, or null for data:, blob:, javascript:, mailto:, fragments... */
export function absUrl(u, base) {
  if (u == null) return null;
  const s = cleanUrl(u);
  if (!s || s.startsWith("#") || /^(data|blob|javascript|mailto|tel|about|sms|whatsapp):/i.test(s)) return null;
  try {
    const x = new URL(s, base);
    if (!/^https?:$/.test(x.protocol)) return null;
    x.hash = "";
    return x.href;
  } catch { return null; }
}

/** srcset per the HTML spec (URLs may contain commas; descriptors end at a top-level comma). */
export function parseSrcset(s) {
  const out = [];
  const str = String(s || "");
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /[\s,]/.test(str[i])) i++;
    if (i >= str.length) break;
    let j = i;
    while (j < str.length && !/\s/.test(str[j])) j++;
    let url = str.slice(i, j);
    i = j;
    let desc = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      let depth = 0, k = i;
      for (; k < str.length; k++) { const ch = str[k]; if (ch === "(") depth++; else if (ch === ")") depth--; else if (ch === "," && depth <= 0) break; }
      desc = str.slice(i, k).trim();
      i = k + 1;
    }
    if (url) out.push({ url, desc });
  }
  return out;
}
export const stringifySrcset = (list) => list.map((c) => (c.desc ? `${c.url} ${c.desc}` : c.url)).join(", ");

const EXT = {
  image: /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|apng|jxl|heic)$/i,
  font: /\.(woff2?|ttf|otf|eot)$/i,
  media: /\.(mp4|webm|mov|m4v|ogv|ogg|mp3|wav|m4a|aac|m3u8|vtt)$/i,
  style: /\.css$/i,
  script: /\.(m?js)$/i,
  data: /\.(json|lottie|riv|glb|gltf|pdf|txt|webmanifest|zip)$/i,
};
/** Rough type of a URL by extension: image | font | media | style | script | data | other. */
export function kindOf(url) {
  let p;
  try { p = new URL(url).pathname; } catch { p = String(url).split(/[?#]/)[0]; }
  for (const [k, re] of Object.entries(EXT)) if (re.test(p)) return k;
  if (/fonts\.googleapis\.com\/css/.test(url)) return "style";
  return "other";
}
export const isAssetKind = (k) => ["image", "font", "media", "data"].includes(k);

/** Accept headers as Chromium sends them: CDNs negotiate formats (AVIF/WebP) by Accept, so bytes differ. */
export const ACCEPT = {
  document: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  style: "text/css,*/*;q=0.1",
  script: "*/*",
  font: "*/*",
  media: "*/*",
  data: "*/*",
  other: "*/*",
};

const stripWww = (h) => h.replace(/^www\./, "");
export const sameSite = (a, b) => { try { return stripWww(new URL(a).host) === stripWww(new URL(b).host); } catch { return false; } };

const NON_PAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|rar|7z|gz|mp4|webm|mov|mp3|wav|xml|json|txt|css|js|mjs|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|csv|rss|atom|xsl)$/i;
const SKIP_PATH = /^\/(?:wp-admin|wp-login\.php|wp-json|xmlrpc\.php|feed|comments\/feed|cdn-cgi|_next|_framer|wp-content|wp-includes|\.well-known|cart|checkout|my-account|account|login|logout)(?:\/|$)|\/feed\/?$|\/embed\/?$|\/amp\/?$|\/page\/\d+\/?$/i;

/** Route (pathname) of a same-site page link, or null for external links, assets, admin/feed URLs. */
export function routeFromHref(href, base, live) {
  if (!href) return null;
  const s = cleanUrl(href);
  if (/^(mailto|tel|javascript|data|sms|whatsapp):/i.test(s) || s.startsWith("#")) return null;
  try {
    const u = new URL(s, base);
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.href, live)) return null;
    if (NON_PAGE_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
    if (u.searchParams.has("replytocom") || u.searchParams.has("add-to-cart")) return null;
    return u.pathname || "/";
  } catch { return null; }
}

/** Route patterns: exact ("/about"), trailing-slash-insensitive, "*" wildcard ("/blog/*"). */
export function routeMatches(route, pattern) {
  const norm = (s) => (s.length > 1 ? s.replace(/\/$/, "") : s);
  if (!pattern.includes("*")) return norm(route) === norm(pattern);
  const re = new RegExp("^" + norm(pattern).split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "/?$");
  return re.test(route);
}

// ---------------------------------------------------------------- CSS

export const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?:[^)\\\s"']|\\.)*))\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/gi;

/** Splits on `sep` outside quotes and parentheses. */
export function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === "\\") { cur += s[++i] ?? ""; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** "a: b; c: d !important" -> [{prop, value, important}] (quote/paren aware). */
export function parseDecls(s) {
  const out = [];
  for (const d of splitTopLevel(String(s || ""), ";")) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    const prop = d.slice(0, i).trim();
    let value = d.slice(i + 1).trim();
    if (!prop) continue;
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    out.push({ prop, value, important });
  }
  return out;
}

/** @import targets of a stylesheet: [{url, media}]. */
export function cssImports(css, base) {
  const out = [];
  for (const m of stripCssComments(css).matchAll(IMPORT_RE)) {
    const u = absUrl(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], base);
    if (u) out.push({ url: u, media: (m[6] || "").trim() });
  }
  return out;
}

/** Every url()/image-set() reference of a stylesheet (absolute), excluding @import targets. */
export function cssRefs(css, base) {
  const t = stripCssComments(css);
  const imports = new Set(cssImports(t, base).map((x) => x.url));
  const out = new Set();
  for (const m of t.matchAll(URL_RE)) {
    const u = absUrl(m[1] ?? m[2] ?? m[3] ?? "", base);
    if (u && !imports.has(u)) out.add(u);
  }
  for (const m of t.matchAll(/image-set\(([^;{}]*)\)/gi))
    for (const s of m[1].matchAll(/(?<!url\(\s*)"((?:[^"\\]|\\.)*)"|(?<!url\(\s*)'((?:[^'\\]|\\.)*)'/g)) {
      const u = absUrl(s[1] ?? s[2], base);
      if (u) out.add(u);
    }
  return [...out];
}

/** Rewrites url() references: fn(absUrl, raw) returns the replacement URL or null to keep. Keeps #fragments. */
export function rewriteCssUrls(css, base, fn) {
  return css.replace(URL_RE, (all, d, s, b) => {
    const raw = d ?? s ?? b ?? "";
    const u = absUrl(raw, base);
    if (!u) return all;
    const r = fn(u, raw);
    if (!r) return all;
    const hash = raw.includes("#") ? raw.slice(raw.indexOf("#")) : "";
    return `url("${r}${hash}")`;
  });
}

/** @font-face rules: [{family, weight, style, display, unicodeRange, src: [{url, format}]}]. */
export function fontFaces(css, base) {
  const out = [];
  for (const m of stripCssComments(css).matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const d = Object.fromEntries(parseDecls(m[1]).map((x) => [x.prop.toLowerCase(), x.value]));
    const src = [];
    for (const part of splitTopLevel(d.src || "", ",")) {
      const um = part.match(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i);
      const fm = part.match(/format\(\s*["']?([^"')]+)["']?\s*\)/i);
      const lm = part.match(/local\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (um) { const u = absUrl(um[1] ?? um[2] ?? um[3], base); if (u) src.push({ url: u, format: fm?.[1] || null }); }
      else if (lm) src.push({ local: lm[1] });
    }
    out.push({
      family: (d["font-family"] || "").replace(/^["']|["']$/g, ""),
      weight: d["font-weight"] || "normal",
      style: d["font-style"] || "normal",
      display: d["font-display"] || null,
      unicodeRange: d["unicode-range"] || null,
      src,
    });
  }
  return out;
}

/** @media preludes with counts, plus the px widths used (em/rem converted at 16px). */
export function mediaQueries(css) {
  const counts = {};
  for (const m of stripCssComments(css).matchAll(/@media\s*([^{]+)\{/gi)) {
    const q = m[1].replace(/\s+/g, " ").trim();
    counts[q] = (counts[q] || 0) + 1;
  }
  return counts;
}
export function breakpointWidths(queryCounts) {
  const w = {};
  for (const [q, n] of Object.entries(queryCounts)) {
    for (const m of q.matchAll(/\((min|max)-width\s*:\s*([\d.]+)(px|em|rem)\)/gi)) {
      const px = Math.round(parseFloat(m[2]) * (m[3].toLowerCase() === "px" ? 1 : 16) * 100) / 100;
      const k = `${m[1].toLowerCase()}-width:${px}`;
      w[k] = (w[k] || 0) + n;
    }
    for (const m of q.matchAll(/\(\s*([\d.]+)px\s*(<=?|>=?)\s*width\s*(?:(<=?)\s*([\d.]+)px)?\)|\(\s*width\s*(<=?|>=?)\s*([\d.]+)px\s*\)/gi)) {
      const px = Number(m[1] || m[6]);
      if (!px) continue;
      const k = `range-width:${px}`;
      w[k] = (w[k] || 0) + n;
    }
  }
  return Object.entries(w).map(([k, count]) => { const [feature, px] = k.split(":"); return { feature, px: Number(px), count }; })
    .sort((a, b) => b.count - a.count || a.px - b.px);
}

// ---------------------------------------------------------------- JS

/** Closes the bracket opened at t[i] in JavaScript source: skips '...', "...", `...` strings and comments. */
export function matchJsBracket(t, i) {
  let d = 0;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      j++;
      while (j < t.length && t[j] !== q) { if (t[j] === "\\") j++; j++; }
      continue;
    }
    if (c === "/" && t[j + 1] === "*") { j = t.indexOf("*/", j + 2); if (j < 0) return -1; j++; continue; }
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === "}" || c === "]" || c === ")") { d--; if (d === 0) return j + 1; }
  }
  return -1;
}

/**
 * Parses a JavaScript *literal* (object/array/string/number/boolean/null as minifiers emit them: unquoted keys,
 * 'single' quotes, !0/!1, void 0, 0x1f, .5, 1e3, trailing commas). Never evaluates code: anything else
 * (identifiers, calls, functions) throws. Used for Webflow IX2/IX3 data, which is a JS object, not JSON.
 */
export function parseJsLiteral(src) {
  let i = 0;
  const s = src;
  const err = (m) => { throw new Error(`${m} at ${i}: ${s.slice(i, i + 40)}`); };
  const ws = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) err("comment"); i = e + 2; continue; }
      if (s[i] === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
      break;
    }
  };
  const str = () => {
    const q = s[i++];
    let out = "";
    while (i < s.length && s[i] !== q) {
      if (s[i] === "\\") {
        const c = s[++i];
        const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
        if (c === "u") {
          if (s[i + 1] === "{") { const e = s.indexOf("}", i); out += String.fromCodePoint(parseInt(s.slice(i + 2, e), 16)); i = e + 1; }
          else { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 5; }
          continue;
        }
        if (c === "x") { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 3; continue; }
        if (c === "\n") { i++; continue; }
        out += map[c] ?? c;
        i++;
        continue;
      }
      if (q === "`" && s[i] === "$" && s[i + 1] === "{") err("template expression");
      out += s[i++];
    }
    if (s[i] !== q) err("unterminated string");
    i++;
    return out;
  };
  const num = () => {
    const m = s.slice(i).match(/^[-+]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/);
    if (!m) err("number");
    i += m[0].length;
    const t = m[0].replace(/^\+/, "");
    const neg = t.startsWith("-");
    const body = neg ? t.slice(1) : t;
    const v = /^0[xXbBoO]/.test(body) ? Number(body) : parseFloat(body);
    return neg ? -v : v;
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const o = {};
      for (;;) {
        ws();
        if (s[i] === "}") { i++; return o; }
        let k;
        if (s[i] === '"' || s[i] === "'") k = str();
        else if (/[\d.]/.test(s[i])) k = String(num());
        else { const m = s.slice(i).match(/^[A-Za-z_$][\w$]*/); if (!m) err("key"); k = m[0]; i += k.length; }
        ws();
        if (s[i] !== ":") err("expected ':'");
        i++;
        o[k] = value();
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return o; }
        err("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const a = [];
      for (;;) {
        ws();
        if (s[i] === "]") { i++; return a; }
        if (s[i] === ",") { i++; a.push(undefined); continue; }
        a.push(value());
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return a; }
        err("expected ',' or ']'");
      }
    }
    if (c === '"' || c === "'" || c === "`") return str();
    if (c === "!") {
      i++;
      ws();
      if (s[i] === "0") { i++; return true; }
      if (s[i] === "1") { i++; return false; }
      err("unsupported !");
    }
    if (s.startsWith("void 0", i)) { i += 6; return null; }
    for (const [w, v] of [["true", true], ["false", false], ["null", null], ["undefined", null], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]])
      if (s.startsWith(w, i) && !/[\w$]/.test(s[i + w.length] || "")) { i += w.length; return v; }
    if (/[-+\d.]/.test(c)) return num();
    err("unsupported token");
  };
  const v = value();
  ws();
  if (i < s.length) err("trailing input");
  return v;
}

/** Finds `<prefix>(` calls in JS and parses their literal arguments: [{index, args, error?, text}]. */
export function literalCallArgs(js, prefixRe) {
  const out = [];
  const re = new RegExp(prefixRe.source + "\\s*\\(", prefixRe.flags.includes("g") ? prefixRe.flags : prefixRe.flags + "g");
  for (const m of js.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const end = matchJsBracket(js, open);
    if (end < 0) { out.push({ index: m.index, error: "unbalanced", text: "" }); continue; }
    const text = js.slice(open + 1, end - 1);
    try { out.push({ index: m.index, args: parseJsLiteral(`[${text}]`), text }); }
    catch (e) { out.push({ index: m.index, error: e.message.slice(0, 160), text }); }
  }
  return out;
}

/** Library versions from script URLs, script bodies (license banners) and page globals. Cheap and best effort. */
export function libFingerprints({ urls = [], bodies = [], globals = {} } = {}) {
  const libs = {};
  const set = (k, v) => { if (v && !libs[k]) libs[k] = v; else if (!libs[k]) libs[k] = true; };
  const URL_PATTERNS = [
    ["gsap", /gsap(?:@|\/|[.-])(\d+\.\d+\.\d+)/i], ["ScrollTrigger", /ScrollTrigger(?:@|\/|[.-])(\d+\.\d+\.\d+)/i],
    ["swiper", /swiper(?:@|\/|-bundle[.-]|[.-])(\d+(?:\.\d+){0,2})/i], ["jquery", /jquery(?:@|\/|[.-])(\d+\.\d+\.\d+)/i],
    ["lenis", /lenis(?:@|\/)(\d+\.\d+\.\d+)/i], ["aos", /aos(?:@|\/)(\d+\.\d+\.\d+)/i], ["splide", /splide(?:@|\/)(\d+\.\d+\.\d+)/i],
    ["lottie", /lottie(?:-web|-player)?(?:@|\/)(\d+\.\d+\.\d+)/i], ["three", /three(?:@|\/)(\d+\.\d+\.\d+)/i],
    ["slick", /slick(?:-carousel)?(?:@|\/)(\d+\.\d+\.\d+)/i], ["owl", /owl\.?carousel(?:@|\/)?(\d+\.\d+\.\d+)?/i],
    ["locomotive", /locomotive-scroll(?:@|\/)?(\d+\.\d+\.\d+)?/i], ["barba", /barba(?:@|\/)(\d+\.\d+\.\d+)/i],
  ];
  const NAME_ONLY = [["aos", /\/aos(\.min)?\.js/i], ["wow", /\/wow(\.min)?\.js/i], ["slick", /slick(\.min)?\.js/i], ["swiper", /swiper[\w.-]*\.js/i],
    ["gsap", /gsap(\.min)?\.js/i], ["ScrollTrigger", /ScrollTrigger(\.min)?\.js/i], ["lottie", /lottie[\w.-]*\.js/i], ["rellax", /rellax/i],
    ["isotope", /isotope/i], ["fancybox", /fancybox/i], ["magnific", /magnific-popup/i], ["lenis", /lenis/i], ["splide", /splide/i], ["flickity", /flickity/i]];
  for (const u of urls) {
    for (const [k, re] of URL_PATTERNS) { const m = u.match(re); if (m) set(k, m[1]); }
    for (const [k, re] of NAME_ONLY) if (re.test(u.split("?")[0])) set(k);
  }
  const BODY = [["gsap", /GSAP\s+(\d+\.\d+\.\d+)/], ["ScrollTrigger", /ScrollTrigger\s+(\d+\.\d+\.\d+)/], ["swiper", /Swiper\s+(\d+\.\d+\.\d+)/],
    ["jquery", /jQuery v(\d+\.\d+\.\d+)/], ["splide", /Splide\.js\s*\n?\s*\*?\s*Version\s*:\s*(\d+\.\d+\.\d+)/], ["lottie", /lottie-web[^\d]{0,40}(\d+\.\d+\.\d+)/],
    ["owl", /Owl Carousel v(\d+\.\d+\.\d+)/], ["slick", /Version:\s*(\d+\.\d+\.\d+)\s*\n\s*Author: Ken Wheeler/], ["three", /REVISION\s*=\s*["'](\d+)["']/],
    ["lenis", /lenis[^\n]{0,80}version[^\d]{0,10}(\d+\.\d+\.\d+)/i], ["aos", /\bAOS\b.{0,200}data-aos/s]];
  for (const b of bodies) {
    if (!b) continue;
    const head = b.length > 400000 ? b.slice(0, 200000) + b.slice(-200000) : b;
    for (const [k, re] of BODY) { const m = head.match(re); if (m) set(k, m[1] && /\d/.test(m[1]) ? m[1] : undefined); }
  }
  for (const [k, v] of Object.entries(globals || {})) if (v) set(k, typeof v === "string" ? v : undefined);
  return libs;
}

// ---------------------------------------------------------------- <head>

const ICON_RELS = /(^|\s)(icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|fluid-icon)(\s|$)/i;

/**
 * Head facts of a document. Looks at the whole document (Next.js can stream metadata into <body>), ignoring
 * svg/math content (an svg <title> is not the page title).
 */
export function headFacts(html) {
  const doc = typeof html === "string" ? parseHtml(html) : html;
  const els = elements(doc, { template: false, foreign: false }).filter((n) => !n.namespaceURI || n.namespaceURI === HTML_NS);
  const htmlEl = els.find((n) => n.tagName === "html");
  const bodyEl = els.find((n) => n.tagName === "body");
  const head = {
    lang: attr(htmlEl, "lang") ?? null, dir: attr(htmlEl, "dir") ?? null, htmlAttrs: attrMap(htmlEl),
    bodyClass: attr(bodyEl, "class") ?? "", bodyAttrs: attrMap(bodyEl),
    title: null, description: null, robots: null, viewport: null, themeColor: null, charset: null, generator: [],
    canonical: null, base: null, manifest: null, og: {}, twitter: {}, hreflang: [], icons: [], jsonLd: [], metas: [], preloads: [], feeds: [],
  };
  const titleEl = els.find((n) => n.tagName === "title");
  if (titleEl) head.title = textOf(titleEl);
  const push = (obj, k, v) => { if (k in obj) obj[k] = [].concat(obj[k], v); else obj[k] = v; };
  for (const n of els) {
    if (n.tagName === "meta") {
      const a = attrMap(n);
      if (a.charset) { head.charset = a.charset; continue; }
      const key = a.name ?? a.property ?? a["http-equiv"] ?? a.itemprop;
      if (!key || a.content === undefined) continue;
      if (a.itemprop && !a.name && !a.property) continue; // microdata, not head metadata
      const k = key.toLowerCase();
      head.metas.push({ [a.name !== undefined ? "name" : a.property !== undefined ? "property" : "http-equiv"]: key, content: a.content, ...(a.media ? { media: a.media } : {}) });
      if (k === "description" && head.description === null) head.description = a.content;
      else if (k === "robots" && head.robots === null) head.robots = a.content;
      else if (k === "viewport") head.viewport = a.content;
      else if (k === "theme-color" && head.themeColor === null) head.themeColor = a.content;
      else if (k === "generator") head.generator.push(a.content);
      else if (k.startsWith("twitter:")) push(head.twitter, k, a.content);
      else if (a.property !== undefined || k.startsWith("og:") || k.startsWith("article:") || k.startsWith("fb:")) push(head.og, k, a.content);
    } else if (n.tagName === "link") {
      const a = attrMap(n);
      const rel = (a.rel || "").toLowerCase();
      if (!a.href && !a.imagesrcset) continue;
      if (rel === "canonical" && head.canonical === null) head.canonical = a.href;
      else if (rel === "alternate" && a.hreflang) head.hreflang.push({ hreflang: a.hreflang, href: a.href });
      else if (rel === "alternate" && /rss|atom/.test(a.type || "")) head.feeds.push({ type: a.type, title: a.title || null, href: a.href });
      else if (ICON_RELS.test(rel)) head.icons.push({ rel, href: a.href, type: a.type || null, sizes: a.sizes || null, ...(a.color ? { color: a.color } : {}), ...(a.media ? { media: a.media } : {}) });
      else if (rel === "manifest") head.manifest = a.href;
      else if (rel === "preload" || rel === "modulepreload") head.preloads.push({ rel, as: a.as || null, href: a.href || null, imagesrcset: a.imagesrcset || null, imagesizes: a.imagesizes || null, type: a.type || null, crossorigin: a.crossorigin ?? null, fetchpriority: a.fetchpriority || null, media: a.media || null });
    } else if (n.tagName === "base" && head.base === null) head.base = attr(n, "href") ?? null;
    else if (n.tagName === "script" && /ld\+json/i.test(attr(n, "type") || "")) {
      const raw = textOf(n).trim();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* invalid JSON-LD is kept raw */ }
      head.jsonLd.push({ types: jsonLdTypes(json), json, ...(json ? {} : { raw }) });
    }
  }
  head.hreflang.sort((a, b) => a.hreflang.localeCompare(b.hreflang) || String(a.href).localeCompare(String(b.href)));
  return head;
}

export function jsonLdTypes(json) {
  const out = [];
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    if (v["@type"]) out.push(...[].concat(v["@type"]));
    if (v["@graph"]) visit(v["@graph"]);
  };
  visit(json);
  return out;
}

/** Flat, comparable view of headFacts (used by head-check). */
export function headDigest(h) {
  const j = (v) => (v == null ? null : Array.isArray(v) ? v.join(" | ") : String(v));
  const d = {
    "html lang": h.lang, title: h.title, description: h.description, robots: h.robots, viewport: h.viewport,
    canonical: h.canonical, hreflang: h.hreflang.map((x) => `${x.hreflang}=${x.href}`).join(" ") || null,
    icons: h.icons.map((x) => `${x.rel} ${x.href}${x.sizes ? " " + x.sizes : ""}`).sort().join(" | ") || null,
    "json-ld types": h.jsonLd.flatMap((x) => x.types).sort().join(",") || null,
  };
  for (const [k, v] of Object.entries(h.og)) d[k] = j(v);
  for (const [k, v] of Object.entries(h.twitter)) d[k] = j(v);
  return d;
}

// ---------------------------------------------------------------- snapshot layout

/** Path of a stylesheet copy inside snapshots/<date>/css/ (and css-local/): "<host>/<path>[__<qhash>].css". */
export function cssFileRel(url) {
  const prefix = config().mirrorPrefix;
  const mp = mirrorPath(url);
  let rel = mp.startsWith(prefix + "/") ? mp.slice(prefix.length + 1) : mp.replace(/^\/+/, "");
  if (!/\.css$/i.test(rel)) rel += ".css";
  return rel;
}

/** Absolute asset URLs found anywhere in raw HTML/JS text (JSON escapes undone), filtered by host predicate. */
export function scanAssetUrls(text, pageUrl, hostOk) {
  const t = text.replace(/\\u002f/gi, "/").replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
  const out = new Set();
  const take = (s) => {
    const u = absUrl(s.replace(/[,.;]+$/, ""), pageUrl);
    if (!u || !isAssetKind(kindOf(u))) return;
    if (hostOk(new URL(u).host)) out.add(u);
  };
  for (const m of t.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[^\s"'<>()\\`]*/gi)) take(m[0]);
  for (const m of t.matchAll(/["'(,\s=](\/(?!\/)[^\s"'<>()\\`,]+?\.(?:png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|woff2?|ttf|otf|json|lottie|pdf)(?:\?[^\s"'<>()\\`]*)?)(?=["')\s,]|$)/gi)) take(m[1]);
  return [...out];
}

// ---------------------------------------------------------------- misc

/** Runs fn over items with at most n in flight; returns results in order. */
export async function pool(items, n, fn) {
  const q = items.map((x, i) => [x, i]);
  const res = new Array(items.length);
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (q.length) { const [x, i] = q.shift(); res[i] = await fn(x, i); }
  }));
  return res;
}

/** Writes a file creating parent dirs; atomic (temp + rename) so an interrupted run never leaves half files. */
export function writeFileSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export const readJson = (f, def = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };

/** Analytics/beacon endpoints blocked while snapshotting (keeps the rendered DOM clean and avoids fake hits). */
export const TRACKER_PATTERNS = [
  "*google-analytics.com*", "*googletagmanager.com*", "*doubleclick.net*", "*connect.facebook.net*", "*facebook.com/tr*",
  "*hotjar.com*", "*hotjar.io*", "*clarity.ms*", "*segment.io*", "*cdn.segment.com*", "*mixpanel.com*", "*plausible.io/api*",
  "*events.framer.com*", "*analytics.tiktok.com*", "*snap.licdn.com*", "*px.ads.linkedin.com*", "*bat.bing.com*",
  "*stats.wp.com*", "*pixel.wp.com*", "*js.hs-scripts.com*", "*js.hs-analytics.net*", "*static.ads-twitter.com*",
  "*analytics.twitter.com*", "*cdn.amplitude.com*", "*api.amplitude.com*", "*fullstory.com*", "*heapanalytics.com*",
];
