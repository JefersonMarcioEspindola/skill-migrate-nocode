// Helpers shared by the QA tools (texts, intent-check, verify-dom). Platform specifics come from
// migrate.config.json via common.mjs; nothing here is site-specific.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse } from "parse5";
import { config, OUT_DIR, ensureDir, readManifest, latestSnapshot, listArg, slugOf } from "./common.mjs";
import * as cmp from "./compare.mjs";

// ---------- routes, locales, output ----------

/** "*" glob or "^regex" match of a route pattern (same rules as dynamicRegions). */
export function routeMatches(pattern, route) {
  if (!pattern || pattern === "*") return true;
  if (pattern.startsWith("^")) return new RegExp(pattern).test(route);
  if (pattern.includes("*")) return new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(route);
  return pattern.replace(/\/$/, "") === route.replace(/\/$/, "") || (pattern === "/" && route === "/");
}

/** Manifest entries [{route, slug, status}] of a snapshot dir, or [] when there is no snapshot. */
export function manifestEntries(snapDir) {
  try {
    const m = readManifest(snapDir || latestSnapshot());
    return (m.routes || []).map((r) => (typeof r === "string" ? { route: r, slug: slugOf(r), status: 200 } : { slug: slugOf(r.route), ...r }));
  } catch {
    return [];
  }
}

/** Routes to check: --routes, else manifest routes that answered < 400 on live, plus config.routes, minus excludeRoutes. */
export function pickRoutes({ snapDir, fallback = ["/"] } = {}) {
  const c = config();
  const explicit = listArg("routes");
  if (explicit.length) return explicit;
  const fromManifest = manifestEntries(snapDir).filter((r) => !r.status || r.status < 400).map((r) => r.route);
  const all = [...new Set([...fromManifest, ...(c.routes || [])])].filter((r) => r !== c.notFoundProbe);
  const kept = all.filter((r) => !(c.excludeRoutes || []).some((p) => routeMatches(p, r)));
  return kept.length ? kept : fallback;
}

const localeCode = (l) => (typeof l === "string" ? l : l?.code || l?.locale || l?.prefix || "");

/** Locale of a route from config.locales (first path segment) — default locale = config.defaultLocale or locales[0]. */
export function localeOf(route) {
  const c = config();
  const codes = (c.locales || []).map(localeCode).filter(Boolean);
  if (!codes.length) return { locale: null, lang: null };
  const first = route.split("/")[1]?.toLowerCase() || "";
  const hit = codes.find((l) => l.toLowerCase() === first);
  const locale = hit || c.defaultLocale || codes[0];
  return { locale, lang: locale.split(/[-_]/)[0].toLowerCase(), prefixed: !!hit };
}

/** <outDir>/<tool>/... (created). */
export const outPath = (...parts) => {
  const p = path.join(OUT_DIR(), ...parts);
  ensureDir(path.extname(p) ? path.dirname(p) : p);
  return p;
};

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return path.relative(process.cwd(), file);
}

/** Dynamic-region selectors for a route (config.dynamicRegions), via compare.mjs when present. */
export const dynamicSelectors = (route) => {
  try { return cmp.dynamicRegions ? cmp.dynamicRegions(route) : []; } catch { return []; }
};

/** Elements injected by the platform or by Next.js that are never content. */
export const NOISE_SELECTORS = [
  ".w-webflow-badge", "#__framer-badge-container", "#wpadminbar", "nextjs-portal", "next-route-announcer",
  "#__next-route-announcer__", "[data-nextjs-toast]", "[data-next-badge-root]", ".grecaptcha-badge", "#ycode-badge",
];

// ---------- text normalization ----------

/** Collapses ASCII whitespace only: NBSP (U+00A0) and narrow NBSP (U+202F) are kept, so they show up as changes. */
export const normText = (s) => String(s ?? "").replace(/[ \t\n\r\f\v]+/g, " ").trim();
/** Terminal-friendly: NBSP shown as ⍽, truncated. */
export const showText = (s, n = 70) => {
  const t = String(s ?? "").replace(/ /g, "⍽").replace(/ /g, "⍽");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Dice coefficient on character bigrams (0..1). */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = grams(a.toLowerCase()), B = grams(b.toLowerCase());
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / (a.length + b.length - 2);
}

// ---------- language heuristic ----------

// Distinctive function words per language. Words shared by several languages weigh 1/k.
export const STOPWORDS = {
  en: "the and is are was were of to with for you your our we this that these those it its from by be been have has had not or at an will can more about which their they them what when who how all into than also just only very would should could there here".split(" "),
  pt: "não você vocês uma com para são também mais muito isso isto ao aos dos das pelo pela pelos pelas nos nas seu sua seus suas como foi está estão já nós quando porque sobre entre até nossa nosso nossos nossas o os e é em um do da no na ou mas ser ter tem têm pode fazer cada onde aqui então".split(" "),
  es: "el los las una con para es está están y que del por pero muy también nuestro nuestra nuestros nuestras sus su lo al más hay ser como cuando porque sobre entre hasta usted ustedes puede hacer cada donde aquí entonces este esta estos estas".split(" "),
  it: "il di che è la per non una sono gli della del con nel nella anche più questo questa ci si le dei alla alle come quando perché sul tra fino nostro nostra essere può fare ogni dove qui allora".split(" "),
  fr: "le la les et est des du un une que qui pour pas dans sur avec nous vous ce cette sont au aux plus être mais ou où comme quand parce entre notre nos votre vos leur leurs peut faire chaque ici alors aussi très".split(" "),
  de: "der die das und ist nicht mit ein eine zu den von für auf sie wir ich es im dem auch sich werden wie oder bei aus nach wenn über unter zwischen unser unsere ihr ihre kann machen jeder hier dann sehr noch nur".split(" "),
};
const WORD_LANGS = (() => {
  const m = new Map();
  for (const [lang, words] of Object.entries(STOPWORDS)) for (const w of words) m.set(w, [...(m.get(w) || []), lang]);
  return m;
})();

/** Guesses the language of a text from function words. Returns {lang, score, second} or null when unsure. */
export function detectLang(text, minWords = 5) {
  const words = String(text).toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.length < minWords) return null;
  const scores = {};
  for (const w of words) {
    const langs = WORD_LANGS.get(w);
    if (langs) for (const l of langs) scores[l] = (scores[l] || 0) + 1 / langs.length;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 2) return null;
  const [lang, score] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  if (score < second * 1.5) return null;
  return { lang, score: Math.round(score * 10) / 10, second: Math.round(second * 10) / 10 };
}

// ---------- content flags ----------

const DEFAULT_TEXTS = new Set([
  "heading", "heading 1", "heading 2", "heading 3", "heading 4", "heading 5", "heading 6", "subheading", "button text", "text link",
  "this is some text inside of a div block.", "your text here", "text goes here", "add your text here", "click here to edit",
  "image description", "insert text here", "write something", "sample text", "edit this text", "type something", "new collection item",
  "untitled", "untitled page", "page title", "hello world!", "hello world", "just another wordpress site", "sample page", "uncategorized",
  "title goes here", "item 1", "item 2", "item 3", "list item", "link text", "block quote", "description", "subtitle", "title", "texto", "título",
  "descrição", "subtítulo", "seu texto aqui", "digite aqui", "insira o texto aqui",
]);
const DUP_OK = new Set(["ha", "bye", "very", "so", "tchau", "no", "yeah", "là", "là", "dum", "bla", "blá", "tic", "tac", "chop", "pom", "quem", "hip"]);
const SOCIAL_FILE_ALT = /\.(jpe?g|png|webp|gif|svg|avif|heic)$/i;
const PLACEHOLDER_ALT = /^(img|image|imagem|imagen|immagine|photo|foto|picture|bild|untitled|screenshot|banner|logo)[\s_-]*\d*$/i;

/** Cheap content checks on one string. cat: text | head | alt | placeholder | aria | button. */
export function contentFlags(text, cat = "text") {
  const t = String(text || "");
  const out = [];
  const add = (flag, detail) => out.push(detail ? { flag, detail } : { flag });
  if (/\blorem\b|\bipsum\b|dolor sit amet/i.test(t)) add("placeholder", "lorem ipsum");
  else if (/image description/i.test(t)) add("placeholder", "Image description");
  else if (/\bplaceholder\b/i.test(t) && cat !== "placeholder") add("placeholder", "placeholder");
  else if (/(^|[\s"“(])Exemplo\b/.test(t) || /^exemplo$/i.test(t.trim())) add("placeholder", "Exemplo");
  else if (DEFAULT_TEXTS.has(t.trim().toLowerCase()) && cat !== "placeholder" && cat !== "aria") add("default-text", t.trim());
  if (/\[object Object\]|\{\{[^}]*\}\}|\$\{[^}]*\}|^(undefined|null|NaN)$|\bundefined\b/.test(t)) add("code-leak", "undefined / {{ }} / [object Object]");
  if (/&(amp|nbsp|lt|gt|quot|apos|#\d{2,5}|#x[0-9a-f]{2,4});/i.test(t)) add("literal-entity", t.match(/&[#\w]+;/)[0]);
  for (const m of t.matchAll(/(?<![\p{L}\p{N}])(\p{L}{2,})\s+\1(?![\p{L}\p{N}])/giu)) {
    if (!DUP_OK.has(m[1].toLowerCase())) { add("duplicated-word", m[0]); break; }
  }
  if (/[\p{L}\p{N}][  ]+[,.](?=\s|$)/u.test(t)) add("space-before-punctuation");
  if (/(\p{L})\1{3,}/u.test(t) && !/w{3,}/i.test(t)) add("repeated-letters");
  if (cat === "alt" && (SOCIAL_FILE_ALT.test(t.trim()) || PLACEHOLDER_ALT.test(t.trim()) || /^[A-Z]{2,4}[_-]?\d{3,}/.test(t.trim()))) add("alt-filename", t.trim());
  return out;
}

// ---------- parse5 helpers (offline HTML) ----------

export const parseHtml = (html) => parse(html);
export const getAttr = (n, name) => n.attrs?.find((a) => a.name === name)?.value;
export const classList = (n) => (getAttr(n, "class") || "").split(/\s+/).filter(Boolean);

export function* walk(node) {
  yield node;
  const kids = node.tagName === "template" && node.content ? node.content.childNodes : node.childNodes || [];
  for (const k of kids) yield* walk(k);
}

/** Tokenizes a simple selector list: compounds (tag, #id, .class, [attr], [attr op "v"]) with descendant/child combinators. */
function compileSelector(sel) {
  const list = [];
  for (const part of splitTop(sel, ",")) {
    const steps = [];
    let comb = " ";
    let buf = "";
    const tokens = [];
    // Split on whitespace / ">" outside brackets and quotes.
    let depth = 0, q = null;
    for (const ch of part.trim()) {
      if (q) { buf += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (depth === 0 && (ch === " " || ch === ">")) { if (buf) tokens.push(buf); buf = ""; if (ch === ">") tokens.push(">"); continue; }
      buf += ch;
    }
    if (buf) tokens.push(buf);
    for (const t of tokens) {
      if (t === ">") { comb = ">"; continue; }
      steps.push({ comb, compound: parseCompound(t) });
      comb = " ";
    }
    if (steps.length) list.push(steps);
  }
  return list;
}

function splitTop(s, sep) {
  const out = [];
  let buf = "", depth = 0, q = null;
  for (const ch of s) {
    if (q) { buf += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function parseCompound(t) {
  const c = { tag: null, ids: [], classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) c.tag = m[1] === "*" ? null : m[1].toLowerCase();
    else if (m[2]) c.ids.push(m[2]);
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], op: m[5], value: m[6] ?? m[7] ?? m[8] });
    if (m[0] === "") re.lastIndex++;
  }
  return c;
}

function matchCompound(n, c) {
  if (!n.tagName) return false;
  if (c.tag && n.tagName !== c.tag) return false;
  if (c.ids.length && !c.ids.every((id) => getAttr(n, "id") === id)) return false;
  if (c.classes.length) { const cl = classList(n); if (!c.classes.every((k) => cl.includes(k))) return false; }
  for (const a of c.attrs) {
    const v = getAttr(n, a.name);
    if (v === undefined) return false;
    if (!a.op) continue;
    const x = a.value ?? "";
    if (a.op === "=" && v !== x) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(x)) return false;
    if (a.op === "^=" && !v.startsWith(x)) return false;
    if (a.op === "$=" && !v.endsWith(x)) return false;
    if (a.op === "*=" && !v.includes(x)) return false;
    if (a.op === "|=" && !(v === x || v.startsWith(x + "-"))) return false;
  }
  return true;
}

const parentEl = (n) => (n.parentNode && n.parentNode.tagName ? n.parentNode : null);

function matchSteps(n, steps, i = steps.length - 1) {
  if (!matchCompound(n, steps[i].compound)) return false;
  if (i === 0) return true;
  if (steps[i].comb === ">") { const p = parentEl(n); return !!p && matchSteps(p, steps, i - 1); }
  for (let p = parentEl(n); p; p = parentEl(p)) if (matchSteps(p, steps, i - 1)) return true;
  return false;
}

const selCache = new Map();
/** Does a parse5 element match a (simple) CSS selector list? Unsupported syntax never matches. */
export function matches(n, selector) {
  if (!selector || !n.tagName) return false;
  let compiled = selCache.get(selector);
  if (!compiled) { compiled = compileSelector(selector); selCache.set(selector, compiled); }
  return compiled.some((steps) => matchSteps(n, steps));
}

export function querySelector(root, selector) {
  for (const n of walk(root)) if (n.tagName && matches(n, selector)) return n;
  return null;
}

// ---------- browser ----------

/** New context + page (DPR 1, bypassCSP so styles can be injected everywhere). */
export async function newPage(browser, width, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true, ignoreHTTPSErrors: true });
  return ctx.newPage();
}

/** Scroll that also drives smooth-scroll libraries (Lenis, ScrollSmoother, Locomotive) — compare.mjs when present. */
export const scrollFn = cmp.scrollFn || ((y) => window.scrollTo(0, y));

/** Navigates and waits for load (+ network idle up to 6 s). Returns the HTTP status. */
export async function gotoPage(page, url, { timeout = 90000, initScript } = {}) {
  if (initScript) await page.addInitScript(initScript);
  const res = await page.goto(url, { waitUntil: "load", timeout });
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  return res?.status() ?? 0;
}

/** Scrolls the whole page (triggers lazy load and scroll reveals), then returns to the top. */
export async function scrollThrough(page, { step = 0.7, pause = 120 } = {}) {
  const vh = page.viewportSize()?.height || 900;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= total; y += Math.floor(vh * step)) { await page.evaluate(scrollFn, y); await page.waitForTimeout(pause); }
  await page.evaluate(scrollFn, 1e7);
  await page.waitForTimeout(400);
  await page.evaluate(scrollFn, 0);
  await page.waitForTimeout(500);
  await page.evaluate(() => { for (const img of document.querySelectorAll("img[loading=lazy]")) img.loading = "eager"; }).catch(() => {});
}

/**
 * In-page helpers installed as window.__qa (run with page.evaluate(QA_HELPERS)). Kept as a string so every tool
 * gets the same definitions without a bundler.
 */
export const QA_HELPERS = `(() => {
  if (window.__qa) return;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(p + '#' + esc(e.id)); break; }
      const cls = [...e.classList].filter((c) => !/^(w-|is-|swiper-slide-|aos-)/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.map(esc).join('.');
      const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const visible = (el, { opacity = false } = {}) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: opacity })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const effOpacity = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const blockish = (el) => { const d = getComputedStyle(el).display; return d !== 'inline' && d !== 'contents'; };
  const SKIP = 'script,style,noscript,template,head,svg,iframe,textarea,select,option';
  /** Text blocks: nearest block-level box of each visible text node. Leaf blocks use innerText (rendered text). */
  const textBlocks = (root, skipSel) => {
    const byBlock = new Map();
    const order = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!/\\S/.test(t.data)) continue;
      const p = t.parentElement;
      if (!p || p.closest(SKIP) || (skipSel && p.closest(skipSel))) continue;
      if (p.checkVisibility && !p.checkVisibility({ visibilityProperty: true })) continue;
      let b = p;
      while (b !== root && b.parentElement && !blockish(b)) b = b.parentElement;
      if (!byBlock.has(b)) { byBlock.set(b, []); order.push(b); }
      byBlock.get(b).push(t);
    }
    const set = new Set(order);
    const out = [];
    for (const b of order) {
      let nested = false;
      for (const other of b.querySelectorAll('*')) if (set.has(other)) { nested = true; break; }
      const text = nested ? byBlock.get(b).map((t) => t.data).join('') : b.innerText;
      out.push({ el: b, text });
    }
    return out;
  };
  const rgba = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const root = (sel) => { try { return (sel && document.querySelector(sel)) || document.body; } catch { return document.body; } };
  window.__qa = { path, visible, effOpacity, blockish, textBlocks, rgba, root, SKIP };
})()`;

export const installHelpers = (page) => page.evaluate(QA_HELPERS);

/** Opens a file or URL in the default browser (macOS open, Linux xdg-open, Windows start). */
export function openInBrowser(target) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

/** Runs async jobs with a fixed concurrency, keeping input order in the result. */
export async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** True when the module is the entry script (robust to symlinks such as /tmp -> /private/tmp). */
export function isMain(metaUrl) {
  if (cmp.isMain) return cmp.isMain(metaUrl);
  try { return fs.realpathSync(new URL(metaUrl).pathname) === fs.realpathSync(process.argv[1]); } catch { return false; }
}
