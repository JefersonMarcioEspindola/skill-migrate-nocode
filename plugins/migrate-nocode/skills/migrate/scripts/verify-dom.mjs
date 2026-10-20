// Compares the normalized DOM under config.rootSelector: local rendering × the snapshot's rendered HTML (tag tree,
// classes, attributes incl. data-* / aria-*, text). Cheap structural check for template collections (dozens of
// pages from one template): run it on every route of the collection instead of measuring each one.
//
// Usage:
//   node tools/migrate/verify-dom.mjs [--routes /work/a,/work/b | --match "^/work/"] [--snap <snapdir>]
//     [--render]                 render local with Playwright (default: fetch the server HTML, no JS)
//     [--against <snapdir>]      compare against another snapshot instead of local (offline)
//     [--ignore "srcset,sizes,data-x-*,class:is-*"] [--ignore-selectors ".cookie,[data-random]"]
//     [--exact-text] [--keep-whitespace] [--max 6] [--out name]
// Ignored by default (on both sides): scripts/styles, comments, whitespace-only text, platform badges, animation
// styles (transform, opacity, visibility, transition…), carousel/AOS/lazy-load runtime classes and attributes,
// carousel clones, GSAP pin-spacers (unwrapped), config.dynamicRegions. Diffs repeated on ≥ 50% of the routes
// (header/footer) are reported once as "shared".
// Output: short summary; details in <outDir>/verify-dom/<name>.json  routes[]: { route, diffs[{path, kind, name?, a, b}] }
import fs from "node:fs";
import path from "node:path";
import { config, arg, listArg, launch, latestSnapshot, slugOf } from "./lib/common.mjs";
import {
  manifestEntries, outPath, writeJson, showText, parseHtml, querySelector, matches, classList, newPage, gotoPage, scrollThrough,
  pool, NOISE_SELECTORS, dynamicSelectors, routeMatches, isMain,
} from "./lib/qa.mjs";

const DROP_TAGS = new Set(["script", "style", "noscript", "link", "meta", "base"]);

/** Attributes added at runtime by libraries/extensions (regex on the name). */
export const RUNTIME_ATTRS = [
  /^data-.*initiali[sz]ed$/, /^data-swiper-slide-index$/, /^data-ll-status$/, /^data-was-processed$/, /^data-lazy-loaded$/,
  /^data-new-gr-c-s-check-loaded$/, /^data-gr-ext-installed$/, /^data-lt-installed$/, /^cz-shortcut-listen$/, /^data-reactroot$/, /^nonce$/,
  /^data-aos-(id|animate)$/, /^data-scroll-(id|speed-init)$/, /^data-splide-initialized$/, /^data-flickity-initialized$/,
];
/** Attributes that carousels add to their own nodes (ignored inside a carousel). */
const CAROUSEL_ATTRS = /^(id|role|aria-.*|tabindex|data-swiper-.*|style)$/;
const CAROUSEL_SCOPE = /^(swiper|splide|slick|flickity|glide|embla|keen-slider|owl-)/;
/** Classes added at runtime. */
export const RUNTIME_CLASSES = [
  /^swiper-(initialized|horizontal|vertical|backface-hidden|slide-(active|next|prev|visible|fully-visible|duplicate.*|blank)|pagination-(bullets.*|horizontal|vertical|bullet.*|lock|clickable|fraction|progressbar)|watch-progress|android|ios|free-mode|pointer-events|css-mode|grab-cursor|autoheight|3d|fade|cube|flip|coverflow|creative|cards|centered|rtl|lock|button-(disabled|lock|hidden)|thumbs|grid.*)$/,
  /^(aos-init|aos-animate|lazyloaded|lazyloading|lazyload|is-inview|in-view|is-loaded|loaded|elementor-invisible|animated|wow)$/,
  /^animate__/, /^slick-(initialized|slider|active|current|visible|dotted|list|track|loading)$/, /^is-(initialized|active|visible|next|prev|selected|draggable|rendered|overflow|focus-in)$/,
  /^splide--(slide|loop|fade|ltr|rtl|ttb|draggable|nav)$/, /^flickity-(enabled|resize)$/, /^glide--(swipeable|carousel|slider|ltr|rtl)$/, /^glide__slide--active$/,
];
/** Elements created at runtime (removed on both sides). */
const RUNTIME_ELEMENTS = /^(swiper-notification|swiper-pagination-bullet|swiper-slide-duplicate|slick-cloned|splide__slide--clone|is-clone)$/;
/** Inline style properties that animations write. */
const ANIM_STYLE = /^(transform|translate|rotate|scale|opacity|visibility|will-change|transition.*|animation.*|transform-origin|backface-visibility|perspective|clip-path|filter|pointer-events|-webkit-.*)$/;

const globToRe = (g) => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

function makeOptions() {
  const user = listArg("ignore");
  const attrIgnore = [...RUNTIME_ATTRS, ...user.filter((s) => !s.startsWith("class:")).map(globToRe)];
  const classIgnore = [...RUNTIME_CLASSES, ...user.filter((s) => s.startsWith("class:")).map((s) => globToRe(s.slice(6)))];
  return {
    attrIgnore, classIgnore,
    exactText: !!arg("exact-text"), keepWs: !!arg("keep-whitespace"),
    skip: [...NOISE_SELECTORS, ...listArg("ignore-selectors")],
  };
}

function normStyle(v, carousel) {
  const decls = [];
  let buf = "", depth = 0;
  for (const ch of String(v)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) { decls.push(buf); buf = ""; } else buf += ch;
  }
  decls.push(buf);
  return decls.map((d) => { const i = d.indexOf(":"); return i < 0 ? null : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim().replace(/\s+/g, " ")]; })
    .filter((d) => d && d[0] && !ANIM_STYLE.test(d[0]) && !(carousel && /^(width|height|margin.*|left|top|right|bottom)$/.test(d[0])))
    .sort((a, b) => a[0].localeCompare(b[0])).map(([k, x]) => `${k}: ${x}`).join("; ");
}

const collapse = (s) => s.replace(/[ \t\n\r\f]+/g, " ");

/** Normalized tree: {tag, attrs, kids} | {t} | {tag, ignored}. Returns an array (pin-spacers unwrap into their children). */
function norm(n, o, skipSel, carousel = false) {
  if (n.nodeName === "#text") return [{ t: o.exactText ? n.value : collapse(n.value) }];
  if (!n.tagName || DROP_TAGS.has(n.tagName)) return [];
  const cls = classList(n);
  if (cls.some((c) => RUNTIME_ELEMENTS.test(c))) return [];
  const kidsOf = () => {
    const kids = [];
    for (const c of n.tagName === "template" && n.content ? n.content.childNodes : n.childNodes || []) {
      if (c.nodeName === "#comment") continue;
      for (const k of norm(c, o, skipSel, carousel || cls.some((x) => CAROUSEL_SCOPE.test(x)))) {
        if (k.t !== undefined && kids.at(-1)?.t !== undefined) kids.at(-1).t += k.t; else kids.push(k);
      }
    }
    return o.keepWs ? kids : kids.filter((k) => k.t === undefined || /\S/.test(k.t));
  };
  if (cls.includes("pin-spacer")) return kidsOf();
  if (skipSel && matches(n, skipSel)) return [{ tag: n.tagName, ignored: true }];
  const inCarousel = carousel || cls.some((c) => CAROUSEL_SCOPE.test(c));
  const attrs = {};
  for (const a of n.attrs || []) {
    if (a.name === "class") continue;
    if (o.attrIgnore.some((re) => re.test(a.name))) continue;
    if (inCarousel && CAROUSEL_ATTRS.test(a.name)) continue;
    const v = a.name === "style" ? normStyle(a.value, inCarousel) : a.value;
    if (a.name === "style" && !v) continue;
    attrs[a.name] = v;
  }
  const keptCls = cls.filter((c) => !o.classIgnore.some((re) => re.test(c))).sort();
  if (keptCls.length) attrs.class = keptCls.join(" ");
  return [{ tag: n.tagName, attrs, kids: kidsOf() }];
}

const keyOf = (k) => (k.t !== undefined ? "#text" : `${k.tag}.${(k.attrs?.class || "").split(" ")[0]}`);
const seg = (k, i) => (k.t !== undefined ? `#text[${i}]` : `${k.tag}${k.attrs?.id ? "#" + k.attrs.id : k.attrs?.class ? "." + k.attrs.class.split(" ")[0] : ""}[${i}]`);

/** LCS alignment of two child lists by key; returns [[i|null, j|null], ...] in order. */
function align(A, B) {
  const ka = A.map(keyOf), kb = B.map(keyOf);
  if (ka.length === kb.length && ka.every((k, i) => k === kb[i])) return ka.map((_, i) => [i, i]);
  if (A.length * B.length > 4e6) return Array.from({ length: Math.max(A.length, B.length) }, (_, i) => [i < A.length ? i : null, i < B.length ? i : null]);
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = ka[i] === kb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs = [];
  let i = 0, j = 0, gapA = [], gapB = [];
  const flush = () => {
    // Inside a gap, pair leftovers with the same tag in order (attribute/text diffs instead of add+remove).
    const usedB = new Set();
    for (const x of gapA) {
      const y = gapB.find((q) => !usedB.has(q) && (A[x].t !== undefined ? B[q].t !== undefined : A[x].tag === B[q].tag));
      if (y !== undefined) { usedB.add(y); pairs.push([x, y]); } else pairs.push([x, null]);
    }
    for (const y of gapB) if (!usedB.has(y)) pairs.push([null, y]);
    gapA = []; gapB = [];
  };
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { flush(); pairs.push([i, j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) gapA.push(i++);
    else gapB.push(j++);
  }
  while (i < n) gapA.push(i++);
  while (j < m) gapB.push(j++);
  flush();
  return pairs;
}

const clip = (s, n = 80) => (s === undefined ? undefined : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

function diffNode(a, b, where, out, limit) {
  if (out.length >= limit) return;
  if (a.t !== undefined || b.t !== undefined) {
    if (a.t === undefined || b.t === undefined) out.push({ path: where, kind: "node", a: a.t !== undefined ? "#text" : `<${a.tag}>`, b: b.t !== undefined ? "#text" : `<${b.tag}>` });
    else if (a.t.trim() !== b.t.trim()) out.push({ path: where, kind: "text", a: clip(a.t.trim()), b: clip(b.t.trim()), ...(a.t.replace(/ /g, " ") === b.t.replace(/ /g, " ") ? { note: "nbsp" } : {}) });
    return;
  }
  if (a.ignored || b.ignored) return;
  if (a.tag !== b.tag) { out.push({ path: where, kind: "tag", a: a.tag, b: b.tag }); return; }
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (a.attrs[k] !== b.attrs[k]) out.push({ path: where, kind: "attr", name: k, a: clip(a.attrs[k], 120), b: clip(b.attrs[k], 120) });
  }
  for (const [i, j] of align(a.kids, b.kids)) {
    if (out.length >= limit) return;
    if (i === null) out.push({ path: `${where} > ${seg(b.kids[j], j)}`, kind: "added", b: describe(b.kids[j]) });
    else if (j === null) out.push({ path: `${where} > ${seg(a.kids[i], i)}`, kind: "removed", a: describe(a.kids[i]) });
    else diffNode(a.kids[i], b.kids[j], `${where} > ${seg(a.kids[i], i)}`, out, limit);
  }
}
const describe = (k) => (k.t !== undefined ? clip(JSON.stringify(k.t.trim()), 60) : `<${k.tag}${k.attrs?.class ? ` class="${clip(k.attrs.class, 40)}"` : ""}>`);

function rootTree(html, rootSel, o, route) {
  const doc = parseHtml(html);
  const r = (rootSel && querySelector(doc, rootSel)) || querySelector(doc, "body");
  if (!r) return null;
  const skipSel = [...o.skip, ...dynamicSelectors(route)].join(",");
  return norm(r, o, skipSel)[0] || null;
}

async function localHtml(routes, { render }) {
  const c = config();
  if (!render) {
    return pool(routes, 6, async (route) => {
      try { const res = await fetch(c.local + route, { redirect: "follow" }); return { route, status: res.status, html: await res.text() }; } catch (e) { return { route, status: 0, error: String(e.message || e) }; }
    });
  }
  const browser = await launch();
  try {
    return await pool(routes, 3, async (route) => {
      const page = await newPage(browser, 1440);
      try {
        if (c.staticFlag) await page.addInitScript((f) => { window[f] = true; }, c.staticFlag);
        const status = await gotoPage(page, c.local + route);
        await scrollThrough(page, { pause: 80 });
        return { route, status, html: await page.content() };
      } catch (e) { return { route, status: 0, error: String(e.message || e).split("\n")[0] }; } finally { await page.context().close().catch(() => {}); }
    });
  } finally { await browser.close(); }
}

const resolveSnap = (p) => (fs.existsSync(path.join(p, "manifest.json")) ? p : path.join(process.cwd(), config().snapshotsDir, p));

export async function run() {
  const c = config();
  const o = makeOptions();
  const snapDir = arg("snap") ? resolveSnap(String(arg("snap"))) : latestSnapshot();
  const against = arg("against") ? resolveSnap(String(arg("against"))) : null;
  const entries = manifestEntries(snapDir);
  const slugByRoute = new Map(entries.map((e) => [e.route, e.slug]));
  let routes = listArg("routes");
  if (!routes.length) routes = entries.filter((e) => (!e.status || e.status < 400) && e.route !== c.notFoundProbe).map((e) => e.route);
  if (arg("match")) routes = routes.filter((r) => routeMatches(String(arg("match")), r));
  routes = routes.filter((r) => !(c.excludeRoutes || []).some((p) => routeMatches(p, r)));
  const limit = 400;
  const fileOf = (dir, route) => path.join(dir, "html", `${slugByRoute.get(route) || slugOf(route)}.html`);

  let sides;
  if (against) {
    const other = new Map(manifestEntries(against).map((e) => [e.route, e.slug]));
    sides = routes.map((route) => {
      const f = path.join(against, "html", `${other.get(route) || slugOf(route)}.html`);
      return fs.existsSync(f) ? { route, status: 200, html: fs.readFileSync(f, "utf8") } : { route, status: 0, error: "not in --against snapshot" };
    });
  } else sides = await localHtml(routes, { render: !!arg("render") });

  const results = [];
  for (const s of sides) {
    const f = fileOf(snapDir, s.route);
    if (!fs.existsSync(f)) { results.push({ route: s.route, error: "not in snapshot" }); continue; }
    if (s.error || s.status >= 400) { results.push({ route: s.route, error: s.error || `HTTP ${s.status}` }); continue; }
    const A = rootTree(fs.readFileSync(f, "utf8"), c.rootSelector, o, s.route);
    const B = rootTree(s.html, c.rootSelector, o, s.route);
    if (!A || !B) { results.push({ route: s.route, error: `root ${c.rootSelector} not found on ${!A ? "snapshot" : "local"}` }); continue; }
    const diffs = [];
    diffNode(A, B, c.rootSelector, diffs, limit);
    results.push({ route: s.route, diffs, truncated: diffs.length >= limit });
  }

  // Shared diffs (same path/kind/value on ≥ 50% of ≥ 3 routes): header, footer, global components.
  const ok = results.filter((r) => r.diffs);
  const sig = (d) => `${d.path}|${d.kind}|${d.name || ""}|${d.a ?? ""}|${d.b ?? ""}`;
  const count = new Map();
  for (const r of ok) for (const k of new Set(r.diffs.map(sig))) count.set(k, (count.get(k) || 0) + 1);
  const sharedKeys = new Set(ok.length >= 3 ? [...count].filter(([, n]) => n >= Math.ceil(ok.length / 2)).map(([k]) => k) : []);
  const shared = [];
  for (const r of ok) {
    for (const d of r.diffs) if (sharedKeys.has(sig(d)) && !shared.some((x) => sig(x) === sig(d))) shared.push({ ...d, routes: count.get(sig(d)) });
    r.own = r.diffs.filter((d) => !sharedKeys.has(sig(d)));
  }

  const name = arg("out", against ? `snap-${path.basename(snapDir)}-vs-${path.basename(against)}` : "local");
  const rel = writeJson(outPath("verify-dom", `${name}.json`), {
    snapshot: path.basename(snapDir), against: against ? path.basename(against) : null, mode: against ? "snapshot" : arg("render") ? "render" : "fetch",
    root: c.rootSelector, at: new Date().toISOString(), shared, routes: results.map(({ own, ...r }) => ({ ...r, own: own?.length })),
  });
  const max = Number(arg("max", 6));
  const bad = ok.filter((r) => r.own.length);
  const errs = results.filter((r) => r.error);
  const fmt = (d) => `${showText(d.path.replace(c.rootSelector + " > ", ""), 70)}: ${d.kind}${d.name ? " " + d.name : ""} ${d.a !== undefined ? `"${showText(d.a, 40)}"` : ""}${d.a !== undefined && d.b !== undefined ? " ≠ " : ""}${d.b !== undefined ? `"${showText(d.b, 40)}"` : ""}${d.note ? ` (${d.note})` : ""}`;
  console.log(`verify-dom: ${results.length} routes vs ${path.basename(snapDir)} (${against ? "snapshot " + path.basename(against) : arg("render") ? "rendered" : "server HTML"}), ${ok.length - bad.length} identical${shared.length ? ` apart from ${shared.length} shared diffs` : ""}, ${bad.length} with differences${errs.length ? `, ${errs.length} errors` : ""}`);
  for (const r of errs.slice(0, 10)) console.log(`  ${r.route}: ${r.error}`);
  for (const r of bad.slice(0, 20)) {
    console.log(`  ${r.route}: ${r.own.length}${r.truncated ? "+" : ""} difference(s)`);
    for (const d of r.own.slice(0, max)) console.log(`    ${fmt(d)}`);
  }
  if (bad.length > 20) console.log(`  … ${bad.length - 20} more routes`);
  if (shared.length) {
    console.log(`  shared (≥50% of routes): ${shared.length}`);
    for (const d of shared.slice(0, max)) console.log(`    x${d.routes} ${fmt(d)}`);
  }
  console.log(`JSON: ${rel}`);
  return { results, shared };
}

if (isMain(import.meta.url)) {
  run().catch((e) => { console.error("verify-dom:", e.message); process.exit(1); });
}
