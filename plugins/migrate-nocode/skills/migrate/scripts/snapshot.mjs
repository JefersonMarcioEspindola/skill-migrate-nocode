// Step 1: snapshot the live site. For every route (sitemap.xml incl. sitemap indexes + same-site links of the home +
// config.routes, minus config.excludeRoutes, + config.notFoundProbe saved as "404") it renders the page in Chromium
// (network idle, full scroll for lazy content, back to top) and saves:
//   snapshots/<date>/html/<slug>.html   rendered DOM (document.documentElement.outerHTML, after JS and scrolling)
//   snapshots/<date>/raw/<slug>.html    raw server HTML (platform data: RSC payload, IX2 JSON, Framer appear data)
//   snapshots/<date>/facts/<slug>.json  status/redirects, head, stylesheets, inline styles, scripts, fonts, assets,
//                                       sections, libs, breakpoints, network, platform facts
//   snapshots/<date>/css/...            every stylesheet as the browser received it (+ css/inline/<hash>.css)
//   snapshots/<date>/js/inline/...      inline scripts (to port by hand), platform/... platform data files
//   snapshots/<date>/manifest.json, routes.json
// Usage: node tools/migrate/snapshot.mjs [--only /,/about,404] [--concurrency 3] [--fresh] [--date YYYY-MM-DD]
//        [--routes-only] [--no-block] [--width 1440] [--max-routes N]
//   --only        comma list of routes (no discovery); "404" means the notFoundProbe; merges into the manifest
//   --fresh       cache buster (?v=<ts> on the document + no-cache headers)
//   --routes-only discovery only (sitemaps + raw home links), writes routes.json, no browser
//   --no-block    do not block analytics/beacon hosts while rendering
import fs from "node:fs";
import path from "node:path";
import { config, SNAP_DIR, slugOf, launch, arg, listArg, isMirroredHost } from "./lib/common.mjs";
import {
  parseHtml, elements, attr, attrMap, classList, textOf, querySelector, sectionNodes, sectionSummary, skippedRootNodes,
  absUrl, cleanUrl, parseSrcset, kindOf, isAssetKind, routeFromHref, routeMatches, sameSite, cssImports, cssRefs, fontFaces,
  mediaQueries, breakpointWidths, headFacts, headDigest, libFingerprints, sha1, today, sleep, writeFileSafe, readJson,
  TRACKER_PATTERNS, cssFileRel, scanAssetUrls,
} from "./lib/capture.mjs";
import { detectPlatform, platformModule } from "./lib/platforms/index.mjs";

const c = config();
const LIVE = c.live;
const date = String(arg("date", today()));
if (!/^\d{4}-\d{2}-\d{2}(T\d{4})?$/.test(date)) throw new Error("--date must be YYYY-MM-DD or YYYY-MM-DDTHHMM");
const dir = path.join(SNAP_DIR(), date);
const FRESH = Boolean(arg("fresh"));
const CONC = Math.min(4, Math.max(1, Number(arg("concurrency", 3)) || 3));
const ONLY = listArg("only");
const BLOCK = !arg("no-block");
const WIDTH = Number(arg("width", 1440)) || 1440;
const HEIGHT = 900;
const MAX_ROUTES = Number(arg("max-routes", 0)) || 0;
const PROBE = c.notFoundProbe;
const PLAIN_UA = c.userAgent || "Mozilla/5.0 (compatible; migrate-nocode snapshot)";
const warnings = [];

// ---------------------------------------------------------------- discovery

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": PLAIN_UA, accept: "application/xml,text/xml,text/html;q=0.9,*/*;q=0.8" } });
    return { ok: r.ok, status: r.status, url: r.url, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, text: "", error: e.message }; }
}

const locs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]+?)\\s*(?:\\]\\]>)?\\s*</${tag}>`, "gi"))].map((m) => cleanUrl(m[1]));

async function sitemapRoutes() {
  const routes = new Set();
  const files = [];
  const seen = new Set();
  const queue = [];
  const robots = await getText(`${LIVE}/robots.txt`);
  if (robots.ok) for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  const fallbacks = [`${LIVE}/sitemap.xml`, `${LIVE}/sitemap_index.xml`, `${LIVE}/wp-sitemap.xml`];
  if (!queue.length) queue.push(fallbacks.shift());
  while (queue.length && files.length < 40) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await getText(u);
    const isIndex = /<sitemapindex/i.test(r.text);
    if (!r.ok || !(isIndex || /<urlset/i.test(r.text))) {
      if (!files.length && fallbacks.length) queue.push(fallbacks.shift());
      continue;
    }
    files.push(u.replace(LIVE, ""));
    if (isIndex) { for (const l of locs(r.text, "loc")) if (sameSite(l, LIVE)) queue.push(l); continue; }
    for (const l of locs(r.text, "loc")) { const rt = routeFromHref(l, LIVE, LIVE); if (rt) routes.add(rt); }
    for (const m of r.text.matchAll(/<xhtml:link[^>]+href="([^"]+)"/gi)) { const rt = routeFromHref(m[1], LIVE, LIVE); if (rt) routes.add(rt); }
  }
  return { routes: [...routes], files };
}

function linksOfHtml(html, base) {
  const out = new Set();
  for (const n of elements(parseHtml(html))) if (n.tagName === "a") { const r = routeFromHref(attr(n, "href"), base, LIVE); if (r) out.add(r); }
  return [...out];
}

function buildRouteList(sm, crawl) {
  const src = new Map();
  const add = (r, s) => { if (!r) return; if (!src.has(r)) src.set(r, new Set()); src.get(r).add(s); };
  sm.forEach((r) => add(r, "sitemap"));
  crawl.forEach((r) => add(r, "crawl"));
  (c.routes || []).forEach((r) => add(r, "config"));
  if (!src.has("/")) add("/", "home");
  const bySlug = new Map();
  let excluded = 0;
  for (const [r, s] of src) {
    if (r === PROBE || (c.excludeRoutes || []).some((p) => routeMatches(r, p))) { excluded++; continue; }
    const slug = slugOf(r);
    if (!bySlug.has(slug)) bySlug.set(slug, { route: r, slug, sources: [...s] });
    else bySlug.get(slug).sources.push(...s);
  }
  let list = [...bySlug.values()].sort((a, b) => (a.route === "/" ? -1 : b.route === "/" ? 1 : a.route.localeCompare(b.route)));
  if (MAX_ROUTES && list.length > MAX_ROUTES) { warnings.push(`route list capped at ${MAX_ROUTES} of ${list.length} (--max-routes)`); list = list.slice(0, MAX_ROUTES); }
  return { list, excluded };
}

/** Groups routes by first segment: 3+ siblings usually mean a CMS collection (blog posts, projects...). */
function collectionsOf(routes) {
  const g = {};
  for (const r of routes) { const seg = r.split("/").filter(Boolean); if (seg.length >= 2) { const k = "/" + seg.slice(0, -1).join("/") + "/*"; g[k] = (g[k] || 0) + 1; } }
  return Object.fromEntries(Object.entries(g).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]));
}

// ---------------------------------------------------------------- rendering

function collectDom({ rootSelector, idAttribute, skipTags }) {
  const abs = (u) => { try { return u ? new URL(u, document.baseURI).href : null; } catch { return null; } };
  const A = { img: [], srcset: [], media: [], poster: [], lazy: [], bg: [], svg: [] };
  for (const img of document.querySelectorAll("img")) {
    A.img.push(img.currentSrc || null, abs(img.getAttribute("src")));
    if (img.getAttribute("srcset")) A.srcset.push(img.getAttribute("srcset"));
  }
  for (const s of document.querySelectorAll("source")) {
    if (s.getAttribute("srcset")) A.srcset.push(s.getAttribute("srcset"));
    if (s.getAttribute("src")) A.media.push(abs(s.getAttribute("src")));
  }
  for (const v of document.querySelectorAll("video, audio")) {
    A.media.push(v.currentSrc || null, abs(v.getAttribute("src")));
    if (v.getAttribute("poster")) A.poster.push(abs(v.getAttribute("poster")));
  }
  const LAZY = ["data-src", "data-srcset", "data-bg", "data-background", "data-background-image", "data-lazy-src", "data-lazy-srcset", "data-lazy-background", "data-poster-url", "data-video-urls", "data-poster"];
  for (const el of document.querySelectorAll(LAZY.map((a) => `[${a}]`).join(","))) for (const a of LAZY) { const v = el.getAttribute(a); if (v) A.lazy.push([a, v]); }
  for (const el of document.querySelectorAll("svg image, svg use, svg feImage")) { const h = el.getAttribute("href") || el.getAttribute("xlink:href"); if (h && !h.startsWith("#")) A.svg.push(abs(h)); }
  const all = document.querySelectorAll("body *");
  const N = Math.min(all.length, 20000);
  const props = ["backgroundImage", "maskImage", "webkitMaskImage", "borderImageSource", "listStyleImage"];
  for (let i = 0; i < N; i++) {
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(all[i], pseudo);
      for (const p of props) { const v = cs[p]; if (v && v.includes("url(")) A.bg.push(v); }
      if (pseudo && cs.content && cs.content.includes("url(")) A.bg.push(cs.content);
    }
  }
  let root = null;
  try { root = document.querySelector(rootSelector); } catch { /* invalid selector */ }
  const sections = root ? [...root.children].filter((e) => !skipTags.includes(e.tagName.toLowerCase())).map((e, index) => {
    const r = e.getBoundingClientRect();
    return { index, tag: e.tagName.toLowerCase(), id: e.id || null, classes: [...e.classList], [idAttribute]: e.getAttribute(idAttribute), top: Math.round(r.top + scrollY), height: Math.round(r.height), display: getComputedStyle(e).display };
  }) : [];
  const styles = [...document.querySelectorAll("style")].map((s) => {
    let text = s.textContent || "";
    let cssom = false;
    if (!text.trim() && s.sheet?.cssRules?.length) { try { text = [...s.sheet.cssRules].map((r) => r.cssText).join("\n"); cssom = true; } catch { /* cross-origin */ } }
    return { id: s.id || null, attrs: Object.fromEntries([...s.attributes].map((a) => [a.name, a.value.length > 300 ? a.value.slice(0, 300) + "..." : a.value])), text, cssom };
  });
  for (const sh of document.adoptedStyleSheets || []) { try { styles.push({ id: null, attrs: { adopted: "" }, text: [...sh.cssRules].map((r) => r.cssText).join("\n"), cssom: true }); } catch { /* ignore */ } }
  return {
    assets: A,
    sections,
    rootFound: !!root,
    styles,
    stylesheets: [...document.querySelectorAll('link[rel~="stylesheet"]')].map((l) => ({ href: l.href, media: l.media || null })).concat([...document.styleSheets].filter((s) => s.href).map((s) => ({ href: s.href, media: s.media?.mediaText || null }))),
    scripts: [...document.scripts].map((s) => ({ src: s.src || null, type: s.getAttribute("type"), async: s.async, defer: s.defer, nomodule: s.noModule, id: s.id || null, text: s.src ? null : s.textContent })),
    links: [...document.querySelectorAll("a[href]")].map((a) => a.href),
    fontsLoaded: document.fonts ? [...new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family.replace(/^["']|["']$/g, "")} ${f.weight} ${f.style}`))] : [],
    globals: {
      gsap: window.gsap?.version, ScrollTrigger: window.ScrollTrigger?.version, jquery: window.jQuery?.fn?.jquery,
      swiper: window.Swiper ? window.Swiper.version || true : undefined, lenis: window.lenisVersion || (window.Lenis ? true : undefined),
      aos: window.AOS ? true : undefined, wow: window.WOW ? true : undefined, lottie: window.lottie?.version || (window.lottie || window.bodymovin ? true : undefined),
      three: window.THREE?.REVISION, splide: window.Splide ? true : undefined, barba: window.barba?.version, alpine: window.Alpine?.version,
      next: window.next?.version, webflow: window.Webflow ? true : undefined, elementorFrontend: window.elementorFrontend?.config?.version,
    },
    metrics: { scrollHeight: document.documentElement.scrollHeight, innerWidth, innerHeight },
    userAgent: navigator.userAgent,
  };
}

async function scrollThrough(page) {
  const step = Math.round(HEIGHT * 0.8);
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  const t0 = Date.now();
  let last = -1, stuck = 0, atBottom = 0;
  while (Date.now() - t0 < 25000) {
    await page.mouse.wheel(0, step);
    await sleep(150);
    const { y, max } = await page.evaluate(() => { const se = document.scrollingElement || document.documentElement; return { y: Math.round(window.scrollY || se.scrollTop), max: se.scrollHeight - innerHeight }; });
    if (y >= max - 2) { if (++atBottom >= 3) break; }
    else if (y === last) {
      // Wheel did not move the window (custom scroller): scroll the window programmatically, then give up.
      if (++stuck >= 4) { await page.evaluate((s) => window.scrollBy(0, s), step); if (stuck >= 8) break; }
    } else { stuck = 0; atBottom = 0; }
    last = y;
  }
  // Inner scrollers (overflow containers) get the same treatment once.
  await page.evaluate(async () => {
    const els = [...document.querySelectorAll("body *")].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).slice(0, 5);
    for (const e of els) { for (let y = 0; y < e.scrollHeight; y += e.clientHeight * 0.8) { e.scrollTop = y; await new Promise((r) => setTimeout(r, 80)); } e.scrollTop = 0; }
  }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const y = await page.evaluate(() => window.scrollY).catch(() => 0);
  if (y > 0) { await page.mouse.wheel(0, -1e6); await sleep(800); }
}

async function capture(context, route) {
  const slug = route === PROBE ? "404" : slugOf(route);
  const base = new URL(route, LIVE).href;
  const url = FRESH ? base + (base.includes("?") ? "&" : "?") + "v=" + Date.now() : base;
  const page = await context.newPage();
  const net = [];
  const failed = [];
  const bodies = { style: new Map(), script: new Map() };
  const pending = [];
  const inflight = new Set();
  let lastActivity = Date.now();
  try {
    if (BLOCK) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setBlockedURLs", { urls: TRACKER_PATTERNS });
    }
    if (FRESH) await page.route((u) => u.href === url, (r) => r.continue({ headers: { ...r.request().headers(), "cache-control": "no-cache", pragma: "no-cache" } }));
    page.on("request", (r) => { if (!["media", "websocket", "eventsource"].includes(r.resourceType())) inflight.add(r); lastActivity = Date.now(); });
    const done = (r) => { inflight.delete(r); lastActivity = Date.now(); };
    page.on("requestfinished", done);
    page.on("requestfailed", (r) => { done(r); const f = r.failure()?.errorText || ""; if (!/BLOCKED_BY_CLIENT|ERR_ABORTED/.test(f)) failed.push({ url: r.url().slice(0, 300), type: r.resourceType(), error: f }); });
    page.on("response", (resp) => {
      const u = resp.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      const type = resp.request().resourceType();
      net.push({ url: u, type, status: resp.status(), ct: (resp.headers()["content-type"] || "").split(";")[0] || null });
      if ((type === "stylesheet" || type === "script") && resp.status() < 300)
        pending.push(resp.text().then((t) => { if (t.length < 4e6) bodies[type === "stylesheet" ? "style" : "script"].set(u, t); }).catch(() => {}));
    });
    const idle = async (quiet = 600, timeout = 10000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (!inflight.size && Date.now() - lastActivity >= quiet) return true; await sleep(100); }
      return false;
    };

    let resp;
    try { resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); }
    catch (e) { return { route, slug, error: e.message.split("\n")[0] }; }
    if (!resp) return { route, slug, error: "no response" };
    const status = resp.status();
    const raw = await resp.text().catch(() => "");
    const headers = resp.headers();
    const redirects = [];
    for (let rq = resp.request().redirectedFrom(); rq; rq = rq.redirectedFrom()) {
      const rr = await rq.response().catch(() => null);
      redirects.unshift({ url: rq.url(), status: rr?.status() ?? null, location: rr?.headers().location ?? null });
    }
    await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
    await idle();
    await scrollThrough(page);
    await idle(600, 8000);
    await page.evaluate(() => document.fonts?.ready.then(() => true)).catch(() => {});
    await sleep(400);
    let rendered;
    try { rendered = await page.content(); } catch { await sleep(1500); rendered = await page.content(); }
    const dom = await page.evaluate(collectDom, { rootSelector: c.rootSelector, idAttribute: c.idAttribute, skipTags: ["script", "noscript", "link", "meta", "template", "base", "title"] });
    await Promise.allSettled(pending);
    const finalUrl = page.url().replace(/([?&])v=\d+(&|$)/, (m, a, b) => (b ? a : "")).replace(/[?&]$/, "");
    return { route, slug, url: base, finalUrl, status, headers, redirects, raw, rendered, dom, net, failed, bodies };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- facts

const written = new Set();
/** Writes a file under the snapshot dir once per run (shared CSS/JS is not rewritten for every page). */
function save(rel, content) {
  const f = path.join(dir, rel);
  if (written.has(f)) return rel;
  writeFileSafe(f, content);
  written.add(f);
  return rel;
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const mirroredHost = (h) => { try { return isMirroredHost(h); } catch { return false; } };

async function stylesheetsOf(cap, context, rawDoc) {
  const list = [];
  const byUrl = new Map();
  const push = (href, media, how, importedBy = null) => {
    const u = absUrl(href, cap.finalUrl);
    if (!u || byUrl.has(u)) return;
    const s = { href: u, media: media || null, how, importedBy };
    byUrl.set(u, s);
    list.push(s);
  };
  for (const n of elements(rawDoc)) if (n.tagName === "link" && /(^|\s)stylesheet(\s|$)/i.test(attr(n, "rel") || "")) push(attr(n, "href"), attr(n, "media"), "raw");
  for (const s of cap.dom.stylesheets) push(s.href, s.media, "dom");
  for (const u of cap.bodies.style.keys()) push(u, null, "network");
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    let body = cap.bodies.style.get(s.href);
    if (body == null) {
      try { const r = await context.request.get(s.href, { headers: { accept: "text/css,*/*;q=0.1" }, timeout: 20000 }); s.status = r.status(); if (r.ok()) body = await r.text(); }
      catch (e) { s.status = 0; s.error = e.message.split("\n")[0]; }
    } else s.status = 200;
    s.body = body ?? "";
    s.bytes = s.body.length;
    s.mirrored = mirroredHost(hostOf(s.href));
    if (body != null) s.file = save(`css/${cssFileRel(s.href)}`, body);
    for (const imp of cssImports(s.body, s.href)) push(imp.url, imp.media, "import", s.href);
  }
  return list;
}

function inlineStylesOf(rawDoc, dom) {
  const byHash = new Map();
  const add = (text, id, attrs, source, cssom = false) => {
    if (!text || !text.trim()) return;
    const hash = sha1(text);
    const cur = byHash.get(hash);
    if (cur) { if (cur.source !== source) cur.source = "both"; return; }
    byHash.set(hash, { hash, id: id || null, attrs, bytes: text.length, source, cssom, file: save(`css/inline/${hash}.css`, text), text });
  };
  for (const n of elements(rawDoc)) if (n.tagName === "style") { const a = attrMap(n); for (const k of Object.keys(a)) if (a[k].length > 300) a[k] = a[k].slice(0, 300) + "..."; add(textOf(n), a.id, a, "raw"); }
  for (const s of dom.styles) add(s.text, s.id, s.attrs, "rendered", s.cssom);
  return [...byHash.values()];
}

function scriptKind(type, text) {
  const t = (type || "").toLowerCase();
  if (/ld\+json/.test(t)) return "json-ld";
  if (t === "importmap") return "importmap";
  if (/json|framer\//.test(t)) return "data";
  if (/^\s*\(?self\.__next_f/.test(text)) return "next-flight";
  if (/self\.__next_s/.test(text)) return "next-s";
  return "js";
}

function scriptsOf(cap, rawDoc) {
  const out = [];
  const ext = new Map();
  const inl = new Map();
  const add = (s, source) => {
    if (s.src) {
      const u = absUrl(s.src, cap.finalUrl);
      if (!u) return;
      if (ext.has(u)) { const e = ext.get(u); if (e.source !== source) e.source = "both"; return; }
      const e = { src: u, type: s.type || null, async: !!s.async, defer: !!s.defer, nomodule: !!s.nomodule, id: s.id || null, inline: false, source, mirrored: mirroredHost(hostOf(u)), bytes: cap.bodies.script.get(u)?.length ?? null };
      ext.set(u, e);
      out.push(e);
      return;
    }
    const text = s.text || "";
    if (!text.trim()) return;
    const hash = sha1(text);
    if (inl.has(hash)) { const e = inl.get(hash); if (e.source !== source) e.source = "both"; return; }
    const kind = scriptKind(s.type, text);
    const e = { src: null, type: s.type || null, id: s.id || null, inline: true, kind, bytes: text.length, hash, source, head: text.slice(0, 120).replace(/\s+/g, " ") };
    if (kind !== "next-flight" && kind !== "json-ld") e.file = save(`js/inline/${hash}.${kind === "data" || kind === "importmap" ? "json" : "js"}`, text);
    inl.set(hash, e);
    out.push(e);
  };
  for (const n of elements(rawDoc)) if (n.tagName === "script") { const a = attrMap(n); add({ src: a.src, type: a.type, async: "async" in a, defer: "defer" in a, nomodule: "nomodule" in a, id: a.id, text: a.src ? null : textOf(n) }, "raw"); }
  for (const s of cap.dom.scripts) add(s, "rendered");
  return out;
}

function assetsOf(cap, rawDoc, sheets, inlineStyles, fonts) {
  const map = new Map();
  const pageUrl = cap.finalUrl;
  const add = (u, kind, base = pageUrl) => {
    const a = absUrl(u, base);
    if (!a) return;
    const k = kindOf(a);
    if (k === "style" || k === "script") return;
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(kind);
  };
  const addList = (v, kind) => {
    if (!v) return;
    if (/url\(/i.test(v)) return cssRefs(v, pageUrl).forEach((u) => add(u, kind));
    const parts = parseSrcset(v);
    if (parts.length > 1 || /\s\d+(\.\d+)?[wx]\s*$/.test(v)) return parts.forEach((p) => add(p.url, kind));
    if (v.includes(",") && !/\s/.test(v.trim())) return v.split(",").forEach((p) => add(p, kind));
    add(v, kind);
  };
  const A = cap.dom.assets;
  A.img.forEach((u) => add(u, "img"));
  A.srcset.forEach((s) => parseSrcset(s).forEach((p) => add(p.url, "srcset")));
  A.media.forEach((u) => add(u, "media"));
  A.poster.forEach((u) => add(u, "poster"));
  A.svg.forEach((u) => add(u, "svg"));
  A.lazy.forEach(([, v]) => addList(v, "lazy"));
  A.bg.forEach((v) => cssRefs(v, pageUrl).forEach((u) => add(u, "bg")));
  for (const n of elements(rawDoc)) {
    const a = attrMap(n);
    if (n.tagName === "img" || n.tagName === "source" || n.tagName === "video" || n.tagName === "audio" || n.tagName === "track") {
      if (a.src) add(a.src, n.tagName === "img" ? "img" : "media");
      if (a.srcset) parseSrcset(a.srcset).forEach((p) => add(p.url, "srcset"));
      if (a.poster) add(a.poster, "poster");
    }
    if (n.tagName === "link" && /icon|apple-touch|preload|manifest|mask-icon|image_src/i.test(a.rel || "")) {
      if (a.href && !/^(script|style|fetch|document)$/.test(a.as || "")) add(a.href, "head");
      if (a.imagesrcset) parseSrcset(a.imagesrcset).forEach((p) => add(p.url, "head"));
    }
    if (n.tagName === "meta" && /^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src|msapplication-TileImage|og:video|og:audio)$/i.test(a.property || a.name || "")) add(a.content, "head");
    if (a.style && /url\(/i.test(a.style)) cssRefs(a.style, pageUrl).forEach((u) => add(u, "style-attr"));
    if ((n.tagName === "image" || n.tagName === "use" || n.tagName === "feImage") && (a.href || a["xlink:href"]) && !(a.href || a["xlink:href"]).startsWith("#")) add(a.href || a["xlink:href"], "svg");
    for (const k of ["data-src", "data-srcset", "data-bg", "data-background", "data-background-image", "data-lazy-src", "data-lazy-srcset", "data-poster-url", "data-video-urls", "data-poster"]) if (a[k]) addList(a[k], "lazy");
  }
  for (const s of inlineStyles) cssRefs(s.text, pageUrl).forEach((u) => add(u, "inline-css"));
  for (const s of sheets) cssRefs(s.body, s.href).forEach((u) => add(u, "css"));
  for (const f of fonts) for (const s of f.src) if (s.url) add(s.url, "font");
  for (const r of cap.net) {
    if (["image", "font", "media"].includes(r.type) && r.status < 400) add(r.url, "network");
    else if (["fetch", "xhr", "other"].includes(r.type) && r.status < 400 && isAssetKind(kindOf(r.url))) add(r.url, "network");
  }
  for (const u of scanAssetUrls(cap.raw, pageUrl, (h) => mirroredHost(h))) add(u, "scan");
  const kinds = {};
  for (const ks of map.values()) for (const k of ks) kinds[k] = (kinds[k] || 0) + 1;
  return { list: [...map.keys()].sort(), kinds };
}

function buildFacts(cap, platform, extras) {
  const { sheets, inlineStyles, scripts, rawDoc } = extras;
  const head = headFacts(/<(title|meta|link)\b/i.test(cap.raw) ? rawDoc : parseHtml(cap.rendered));
  const headR = headFacts(cap.rendered);
  const dA = headDigest(head), dB = headDigest(headR);
  const headRenderedDiff = Object.keys({ ...dA, ...dB }).filter((k) => dA[k] !== dB[k]).map((k) => ({ key: k, raw: dA[k] ?? null, rendered: dB[k] ?? null }));

  // Fonts from every stylesheet + inline style, resolved against the right base URL.
  const faces = [];
  const seenFace = new Set();
  const addFaces = (css, base) => { for (const f of fontFaces(css, base)) { const k = `${f.family}|${f.weight}|${f.style}|${f.unicodeRange}|${f.src[0]?.url || f.src[0]?.local || ""}`; if (!seenFace.has(k)) { seenFace.add(k); faces.push(f); } } };
  sheets.forEach((s) => addFaces(s.body, s.href));
  inlineStyles.forEach((s) => addFaces(s.text, cap.finalUrl));
  const assets = assetsOf(cap, rawDoc, sheets, inlineStyles, faces);

  // Sections: from the raw HTML (what tojsx converts by default), plus geometry from the rendered DOM.
  // Falls back to the rendered DOM when the raw HTML is a client-rendered shell (e.g. a Next.js error page).
  let root = null, sectionsSource = "raw";
  try {
    root = querySelector(rawDoc, c.rootSelector);
    if (!root && cap.dom.rootFound) { root = querySelector(parseHtml(cap.rendered), c.rootSelector); sectionsSource = "rendered"; }
  } catch (e) { warnings.push(`rootSelector: ${e.message}`); }
  const sections = root ? sectionNodes(root).map((n, i) => sectionSummary(n, i, c.idAttribute)) : [];

  const allCss = [...sheets.map((s) => s.body), ...inlineStyles.map((s) => s.text)].join("\n");
  const links = new Set();
  let external = 0;
  for (const h of [...cap.dom.links, ...elements(rawDoc).filter((n) => n.tagName === "a").map((n) => attr(n, "href"))]) {
    const r = routeFromHref(h, cap.finalUrl, LIVE);
    if (r) links.add(r); else if (h && /^https?:/i.test(h) && !sameSite(h, LIVE)) external++;
  }
  const byType = {}, hosts = {};
  for (const r of cap.net) { byType[r.type] = (byType[r.type] || 0) + 1; const h = hostOf(r.url); hosts[h] = (hosts[h] || 0) + 1; }

  const mod = platformModule(platform);
  let platformFacts = null;
  if (mod) {
    try {
      platformFacts = mod.facts(cap.raw, cap.rendered, {
        url: cap.finalUrl, route: cap.route, slug: cap.slug, config: c, rawDoc, save,
        scripts: [...cap.bodies.script].map(([url, body]) => ({ url, body })),
        scriptUrls: scripts.filter((s) => s.src).map((s) => s.src),
        stylesheets: sheets.map((s) => ({ href: s.href, body: s.body })),
        headers: cap.headers,
      });
    } catch (e) { platformFacts = { error: e.message }; warnings.push(`${platform} facts failed on ${cap.route}: ${e.message}`); }
  }

  return {
    route: cap.route, slug: cap.slug, url: cap.url, finalUrl: cap.finalUrl, status: cap.status, redirects: cap.redirects,
    fetchedAt: new Date().toISOString(), platform,
    htmlLang: head.lang, bodyClass: head.bodyClass,
    headers: Object.fromEntries(Object.entries(cap.headers).filter(([k]) => /^(content-type|cache-control|last-modified|etag|server|x-powered-by|link|content-language|x-robots-tag|age|vary)$/i.test(k))),
    head, headRenderedDiff,
    stylesheets: sheets.map(({ body, ...s }) => s),
    inlineStyles: inlineStyles.map(({ text, ...s }) => s),
    scripts,
    fonts: { faces, loaded: cap.dom.fontsLoaded, requests: cap.net.filter((r) => r.type === "font").map((r) => r.url) },
    assets: assets.list, assetKinds: assets.kinds,
    root: { selector: c.rootSelector, idAttribute: c.idAttribute, foundInRaw: !!root && sectionsSource === "raw", sectionsSource: root ? sectionsSource : null, foundInRendered: cap.dom.rootFound, skipped: root ? skippedRootNodes(root).map((n) => n.tagName) : [] },
    sections, sectionsRendered: cap.dom.sections,
    links: { internal: [...links].sort(), external },
    libs: libFingerprints({ urls: scripts.filter((s) => s.src).map((s) => s.src), bodies: [...cap.bodies.script.values()], globals: cap.dom.globals }),
    breakpoints: breakpointWidths(mediaQueries(allCss)).slice(0, 16),
    metrics: cap.dom.metrics,
    network: { requests: cap.net.length, byType, hosts, failed: cap.failed, list: cap.net },
    platformFacts,
  };
}

const publishedOf = (platform, pf, headers) =>
  (pf && (pf.publishedAt || pf.lastPublished || pf.modified || pf.pageOptimizedAt)) || headers?.["last-modified"] || null;

// ---------------------------------------------------------------- main

if (arg("routes-only")) {
  const [sm, home] = await Promise.all([sitemapRoutes(), getText(LIVE + "/")]);
  const { list, excluded } = buildRouteList(sm.routes, home.ok ? linksOfHtml(home.text, home.url || LIVE) : []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify({ live: LIVE, sitemaps: sm.files, excluded, routes: list }, null, 1));
  console.log(`routes: ${list.length} (sitemap ${sm.routes.length} from ${sm.files.length} file(s), excluded ${excluded}) -> ${path.relative(process.cwd(), dir)}/routes.json`);
  process.exit(0);
}

for (const d of ["html", "raw", "facts"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
const browser = await launch();
const contexts = await Promise.all(Array.from({ length: CONC }, () => browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, ...(c.userAgent ? { userAgent: c.userAgent } : {}), ...(c.browserLocale ? { locale: c.browserLocale } : {}) })));

let platform = c.platform && c.platform !== "other" ? c.platform : null;
let detected = null;
let userAgent = null;
const results = [];
const blocked = [];

async function processRoute(context, route) {
  const cap = await capture(context, route);
  if (cap.error) { results.push({ route, slug: cap.slug, status: "error", error: cap.error }); return null; }
  userAgent ||= cap.dom.userAgent;
  if (!detected) {
    detected = detectPlatform(cap.raw || cap.rendered, cap.finalUrl, cap.headers).platform;
    if (!platform) platform = detected;
    else if (detected !== "other" && detected !== platform) warnings.push(`config platform "${platform}" but the site looks like "${detected}"`);
  }
  if ([403, 429, 503].includes(cap.status) && /cf-chl|challenge-platform|just a moment|captcha|access denied/i.test(cap.raw)) blocked.push(`${route}:${cap.status}`);
  const rawDoc = parseHtml(cap.raw || cap.rendered);
  const sheets = await stylesheetsOf(cap, context, rawDoc);
  const inlineStyles = inlineStylesOf(rawDoc, cap.dom);
  const scripts = scriptsOf(cap, rawDoc);
  const facts = buildFacts(cap, platform, { sheets, inlineStyles, scripts, rawDoc });
  fs.writeFileSync(path.join(dir, "html", `${cap.slug}.html`), cap.rendered);
  fs.writeFileSync(path.join(dir, "raw", `${cap.slug}.html`), cap.raw);
  fs.writeFileSync(path.join(dir, "facts", `${cap.slug}.json`), JSON.stringify(facts, null, 1));
  const mod = platformModule(platform);
  results.push({
    route, slug: cap.slug, status: cap.status, finalUrl: cap.finalUrl, redirects: cap.redirects.length, title: facts.head.title,
    rawBytes: cap.raw.length, renderedBytes: cap.rendered.length, sections: facts.sections.length, assets: facts.assets.length,
    stylesheets: facts.stylesheets.length, publishedAt: publishedOf(platform, facts.platformFacts, cap.headers),
    platform: mod?.summarize && facts.platformFacts && !facts.platformFacts.error ? mod.summarize(facts.platformFacts) : null,
  });
  return facts;
}

let discovery = null;
let routes;
try {
  if (ONLY.length) {
    routes = ONLY.map((r) => (r === "404" ? PROBE : r.startsWith("/") ? r : "/" + r));
    routes = [...new Set(routes)];
  } else {
    const [sm, homeFacts] = await Promise.all([sitemapRoutes(), processRoute(contexts[0], "/")]);
    const { list, excluded } = buildRouteList(sm.routes, homeFacts ? homeFacts.links.internal : []);
    discovery = { sitemaps: sm.files, sitemapRoutes: sm.routes.length, crawlRoutes: homeFacts?.links.internal.length || 0, configRoutes: (c.routes || []).length, excluded, total: list.length };
    fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify({ live: LIVE, ...discovery, routes: list }, null, 1));
    routes = [...list.map((x) => x.route).filter((r) => r !== "/"), PROBE];
  }
  const queue = [...routes];
  await Promise.all(contexts.map(async (ctx) => {
    while (queue.length) {
      const r = queue.shift();
      try { await processRoute(ctx, r); } catch (e) { results.push({ route: r, slug: r === PROBE ? "404" : slugOf(r), status: "error", error: e.message.split("\n")[0] }); }
      await sleep(250);
    }
  }));
} finally {
  await browser.close();
}

// Manifest: merged with an existing one for the same date (so --only refreshes routes in place).
const mfile = path.join(dir, "manifest.json");
const prev = readJson(mfile, null);
const bySlug = new Map((prev?.routes || []).map((r) => [r.slug, r]));
for (const r of results) bySlug.set(r.slug, r);
const all = [...bySlug.values()].sort((a, b) => (a.route === "/" ? -1 : b.route === "/" ? 1 : a.route.localeCompare(b.route)));
const home = all.find((r) => r.route === "/");
const manifest = {
  date, snapshotDate: new Date().toISOString(), live: LIVE, platform, detectedPlatform: detected ?? prev?.detectedPlatform ?? null,
  configPlatform: c.platform || null, userAgent: userAgent || prev?.userAgent || null, viewport: { width: WIDTH, height: HEIGHT }, fresh: FRESH,
  rootSelector: c.rootSelector, idAttribute: c.idAttribute, notFoundProbe: PROBE,
  publishedAt: home?.publishedAt ?? prev?.publishedAt ?? null,
  discovery: discovery ?? prev?.discovery ?? null,
  collections: collectionsOf(all.map((r) => r.route)),
  routes: all,
  warnings,
};
fs.writeFileSync(mfile, JSON.stringify(manifest, null, 1));

const non200 = results.filter((r) => r.status !== 200).map((r) => `${r.route}:${r.status}`);
const sum = (k) => results.reduce((a, r) => a + (Number(r[k]) || 0), 0);
console.log(`snapshot ${date} ${platform}${detected && detected !== platform ? ` (detected ${detected})` : ""}: ${results.length} route(s)${discovery ? ` of ${discovery.total + 1} discovered` : ""}, non-200: ${non200.join(", ") || "none"}, sections ${sum("sections")}, assets ${sum("assets")} (sum), stylesheets ${new Set([...written].filter((f) => f.includes(`${path.sep}css${path.sep}`) && !f.includes(`${path.sep}inline${path.sep}`))).size}`);
const shown = results.find((r) => r.route === "/") || results.find((r) => r.platform);
if (shown?.platform) console.log(`  ${shown.route === "/" ? "home" : shown.route}: ${shown.platform}`);
if (blocked.length) console.log(`  BLOCKED by bot protection on ${blocked.join(", ")}: not bypassed; ask the site owner to allowlist or export manually`);
for (const w of warnings.slice(0, 5)) console.log(`  warning: ${w}`);
console.log(`  -> ${path.relative(process.cwd(), dir)}/ (manifest.json, facts/, html/, raw/, css/)`);
