// Section-by-section review, live vs local. Sections = visible children of config.rootSelector (display:contents
// wrappers flattened; a single full-page wrapper is descended into). Every element inside a section is paired:
//   - by config.idAttribute (or id) when that value is unique on the page (Ycode data-layer-id, most Webflow/Framer nodes);
//   - otherwise by DOM path (tag:nth-of-type chain) from the nearest ancestor with a unique id, or from the section
//     (Webflow data-w-id only exists on animated nodes, Framer names repeat, WordPress has few ids).
// Compares the box relative to its section and ~50 computed properties, plus % of differing pixels per section
// (each side aligned by its own section top). Carousel/marquee tracks are a phase exception (x/transform ignored).
// Usage: node tools/migrate/sections.mjs --route /about --width 1440 [--json] [--root SEL]
//        node tools/migrate/sections.mjs --routes /,/about --widths 1440,390 [--concurrency 2] [--quiet]
// Output: <outDir>/<slug>/<width>/sections.json, <outDir>/sections-summary.json (multi-run)
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { config, OUT_DIR, slugOf, ensureDir, launch, arg, listArg, pct } from "./lib/common.mjs";
import { preparePage, fullShot, dynamicRegions, newPage, ensureHelpers, phaseSelectors, isClockPastError, pool, pixelTolerance, isMain } from "./lib/compare.mjs";

export const SECTION_PROPS = ["display", "position", "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "flexGrow", "flexShrink", "rowGap", "columnGap",
  "gridTemplateColumns", "gridTemplateRows", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textTransform", "textDecorationLine", "whiteSpace",
  "color", "backgroundColor", "backgroundImage", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopColor", "borderTopStyle", "borderRadius",
  "opacity", "zIndex", "overflow", "objectFit", "objectPosition", "aspectRatio", "transform", "mixBlendMode", "boxShadow", "filter", "backdropFilter", "visibility"];

async function collect(page, { rootSelector, idAttribute, dynamic, phaseSel }) {
  await ensureHelpers(page);
  return page.evaluate(({ PROPS, rootSelector, idAttribute, dynamic, phaseSel }) => {
    const { rgba, normColors, rectsOf, gifRects } = window.__migrateCmp;
    const COLOR = new Set(["color", "backgroundColor", "borderTopColor"]);
    const COLORISH = new Set(["boxShadow", "backgroundImage", "filter", "backdropFilter"]);
    const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "NEXTJS-PORTAL"]);
    const safe = (sel) => { try { document.querySelector(sel); return true; } catch { return false; } };
    const dynSel = dynamic.filter(safe).join(",");
    const phase = safe(phaseSel) ? phaseSel : "";
    let root = null;
    try { root = document.querySelector(rootSelector); } catch {}
    root ||= document.body;
    const kids = (el) => [...el.children].flatMap((k) => (SKIP.has(k.tagName) ? [] : getComputedStyle(k).display === "contents" ? kids(k) : [k]));
    const shown = (k) => { const r = k.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let secs = kids(root).filter(shown);
    // A single wrapper holding the whole page (Webflow .page-wrapper, Framer root div): descend into it.
    for (let d = 0; d < 6 && secs.length === 1 && kids(secs[0]).filter(shown).length > 1; d++) secs = kids(secs[0]).filter(shown);
    // Unique ids: idAttribute (or id) values that occur once on the page.
    const count = new Map();
    const idOf = (el) => (idAttribute && el.getAttribute(idAttribute)) ? `@${idAttribute}=${el.getAttribute(idAttribute)}` : el.id ? `#${el.id}` : null;
    for (const el of document.querySelectorAll(idAttribute ? `[${CSS.escape(idAttribute)}],[id]` : "[id]")) { const k = idOf(el); if (k) count.set(k, (count.get(k) || 0) + 1); }
    const uniq = (el) => { const k = idOf(el); return k && count.get(k) === 1 ? k : null; };
    const step = (el) => { let n = 1; for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) n++; return `${el.tagName.toLowerCase()}:${n}`; };
    const sx = scrollX, sy = scrollY;
    const sections = [], elements = [];
    let byId = 0, byPath = 0;
    secs.forEach((sec, i) => {
      const sr = sec.getBoundingClientRect();
      sections.push({ i, tag: sec.tagName.toLowerCase(), key: uniq(sec) || `S${i}`, cls: String(sec.className?.baseVal ?? sec.className ?? "").slice(0, 60), x: sr.left + sx, y: sr.top + sy, w: sr.width, h: sr.height });
      const keyOf = (el) => {
        const own = uniq(el);
        if (own) { byId++; return own; }
        const chain = [];
        let a = el;
        for (; a && a !== sec; a = a.parentElement) { const u = a === el ? null : uniq(a); if (u) break; chain.unshift(step(a)); }
        byPath++;
        const anchor = a === sec ? (uniq(sec) || `S${i}`) : uniq(a);
        return `${anchor} > ${chain.join(">")}`;
      };
      for (const el of [sec, ...sec.querySelectorAll("*")]) {
        if (SKIP.has(el.tagName) || el.parentElement?.closest("svg")) continue;
        if (dynSel && el.closest(dynSel)) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const style = {};
        for (const p of PROPS) style[p] = COLOR.has(p) ? rgba(cs[p]) : COLORISH.has(p) ? normColors(cs[p]) : cs[p];
        elements.push({
          key: el === sec ? sections[i].key : keyOf(el), sec: i, tag: el.tagName.toLowerCase(), phase: Boolean(phase && el.closest(phase)),
          text: [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim().slice(0, 40),
          x: Math.round((r.left - sr.left) * 10) / 10, y: Math.round((r.top - sr.top) * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, style,
        });
      }
    });
    return { sections, elements, masks: [...rectsOf(dynSel), ...gifRects()], pairing: { byId, byPath }, rootFound: root !== document.body || rootSelector === "body" };
  }, { PROPS: SECTION_PROPS, rootSelector, idAttribute, dynamic, phaseSel });
}

/** % differing pixels of one section, each side cropped from its own section top; masks painted black on both. */
function sectionPixels(A, B, sl, sc, masksL, masksC) {
  const w = Math.min(A.width, B.width);
  const h = Math.max(1, Math.round(Math.min(sl.h, sc.h)));
  const y0a = Math.round(sl.y), y0b = Math.round(sc.y);
  const crop = (img, y0) => { const o = new PNG({ width: w, height: h }); o.data.fill(255); const hh = Math.max(0, Math.min(h, img.height - y0)); if (hh > 0 && y0 >= 0) PNG.bitblt(img, o, 0, y0, w, hh, 0, 0); return o; };
  const a = crop(A, y0a), b = crop(B, y0b);
  const mask = (o, ms, y0) => { for (const m of ms) for (let y = Math.max(0, Math.floor(m.y - y0)); y < Math.min(h, Math.ceil(m.y + m.h - y0)); y++) for (let x = Math.max(0, Math.floor(m.x)); x < Math.min(w, Math.ceil(m.x + m.w)); x++) { const i = (y * w + x) * 4; o.data[i] = 0; o.data[i + 1] = 0; o.data[i + 2] = 0; o.data[i + 3] = 255; } };
  // masks of either side apply to both (same rect in section coordinates)
  const rel = (ms, y0) => ms.map((m) => ({ ...m, y: m.y - y0 }));
  const both = [...rel(masksL, y0a), ...rel(masksC, y0b)];
  mask(a, both, 0); mask(b, both, 0);
  return Math.round((pixelmatch(a.data, b.data, null, w, h, { threshold: 0.1, includeAA: false }) / (w * h)) * 1e6) / 1e6;
}

async function reviewOnce({ route, width, browser, outDir, rootSelector, clock = true, motion = false }) {
  const c = config();
  const own = !browser;
  browser ||= await launch();
  const [pl, pc] = await Promise.all([newPage(browser, width), newPage(browser, width)]);
  try {
    await Promise.all([preparePage(pl, c.live + route, { side: "live", clock }), preparePage(pc, c.local + route, { side: "local", clock, motion })]);
    const opts = { rootSelector: rootSelector || c.rootSelector || "body", idAttribute: c.idAttribute || "", dynamic: dynamicRegions(route), phaseSel: phaseSelectors() };
    const [L, C] = await Promise.all([collect(pl, opts), collect(pc, opts)]);
    const [sl, sc] = await Promise.all([fullShot(pl), fullShot(pc)]);
    const byKey = new Map();
    for (const e of C.elements) { if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); }
    const report = { route, width, at: new Date().toISOString(), rootSelector: opts.rootSelector, idAttribute: opts.idAttribute, pairing: { live: L.pairing, local: C.pairing },
      sectionCount: { live: L.sections.length, local: C.sections.length }, sections: [], onlyLive: [], onlyLocal: [], exceptions: [] };
    if (!L.rootFound) report.exceptions.push({ type: "root-missing", detail: `${opts.rootSelector} not found on live; used body` });
    const perSec = L.sections.map((s) => ({ ...s, elements: 0, diffs: [], local: C.sections[s.i] || null }));
    let phaseSkipped = 0;
    for (const e of L.elements) {
      const o = byKey.get(e.key)?.shift();
      perSec[e.sec].elements++;
      if (!o) { report.onlyLive.push({ key: e.key, sec: e.sec, tag: e.tag, text: e.text }); continue; }
      const d = [];
      for (const k of ["x", "y", "w", "h"]) {
        if (k === "x" && e.phase) { if (Math.abs(e.x - o.x) > 1) phaseSkipped++; continue; }
        if (Math.abs(e[k] - o[k]) > 1) d.push({ prop: k, live: e[k], local: o[k] });
      }
      if (o.sec !== e.sec) d.push({ prop: "section", live: e.sec, local: o.sec });
      for (const p of SECTION_PROPS) {
        if (p === "transform" && e.phase) continue;
        if (e.style[p] !== o.style[p]) d.push({ prop: p, live: e.style[p], local: o.style[p] });
      }
      if (d.length) perSec[e.sec].diffs.push({ key: e.key, tag: e.tag, text: e.text, d });
    }
    for (const q of byKey.values()) for (const e of q) report.onlyLocal.push({ key: e.key, sec: e.sec, tag: e.tag, text: e.text });
    if (phaseSkipped) report.exceptions.push({ type: "phase", count: phaseSkipped, detail: "carousel/marquee track: x and transform not compared" });
    if (L.sections.length !== C.sections.length) report.exceptions.push({ type: "section-count", live: L.sections.length, local: C.sections.length });
    const A = PNG.sync.read(sl), B = PNG.sync.read(sc);
    for (const s of perSec) {
      const lc = s.local;
      const px = lc ? sectionPixels(A, B, s, lc, L.masks, C.masks) : null;
      report.sections.push({ i: s.i, tag: s.tag, key: s.key, cls: s.cls, yLive: Math.round(s.y), yLocal: lc ? Math.round(lc.y) : null, hLive: Math.round(s.h), hLocal: lc ? Math.round(lc.h) : null,
        elements: s.elements, px, styleDiffs: s.diffs.length, diffs: s.diffs.slice(0, 60) });
    }
    report.ok = bad(report).length === 0 && !report.onlyLive.length && !report.onlyLocal.length;
    if (outDir) { ensureDir(outDir); fs.writeFileSync(path.join(outDir, "sections.json"), JSON.stringify(report, null, 1)); }
    return report;
  } finally {
    await pl.context().close().catch(() => {});
    await pc.context().close().catch(() => {});
    if (own) await browser.close();
  }
}

/** reviewSections({route, width, browser?, outDir?, rootSelector?}) -> report (written to outDir/sections.json). */
export async function reviewSections(opts) {
  const outDir = opts.outDir === undefined ? path.join(OUT_DIR(), slugOf(opts.route), String(opts.width)) : opts.outDir;
  for (let attempt = 0; ; attempt++) {
    try { return await reviewOnce({ ...opts, outDir }); } catch (e) { if (attempt < 2 && isClockPastError(e)) continue; throw e; }
  }
}

export function bad(r) {
  return r.sections.filter((s) => s.hLive !== s.hLocal || s.px === null || s.px >= pixelTolerance() || s.styleDiffs > 0);
}

export function summarize(r, max = 8) {
  const b = bad(r);
  const els = r.sections.reduce((a, s) => a + s.elements, 0);
  const lines = [`${r.ok ? "OK " : "-- "}${r.route} @${r.width}: ${r.sections.length} sections (local ${r.sectionCount.local}), ${els} elements (id ${r.pairing.live.byId} / path ${r.pairing.live.byPath}), with issues ${b.length}, only-live ${r.onlyLive.length}, only-local ${r.onlyLocal.length}`];
  for (const s of b) {
    lines.push(`  section ${s.i} <${s.tag}> ${s.key.slice(0, 40)} h ${s.hLive}/${s.hLocal} px ${s.px === null ? "-" : pct(s.px)} styles ${s.styleDiffs}`);
    for (const e of s.diffs.slice(0, max)) lines.push(`    ${e.tag} ${e.key.slice(-48)}: ${e.d.slice(0, 4).map((p) => `${p.prop} ${p.live}→${p.local}`).join("; ")}`);
  }
  for (const e of r.onlyLive.slice(0, max)) lines.push(`  only-live s${e.sec} ${e.tag} ${e.key.slice(-48)}`);
  for (const e of r.onlyLocal.slice(0, max)) lines.push(`  only-local s${e.sec} ${e.tag} ${e.key.slice(-48)}`);
  return lines.join("\n");
}

if (isMain(import.meta.url)) {
  const routes = listArg("routes", [arg("route", "/")]);
  const widths = listArg("widths", [String(arg("width", 1440))]).map(Number);
  const jobs = routes.flatMap((route) => widths.map((width) => ({ route, width })));
  const browser = await launch();
  const rootSelector = typeof arg("root") === "string" ? arg("root") : undefined;
  const all = await pool(jobs, Number(arg("concurrency", 1)), async ({ route, width }) => {
    try {
      const r = await reviewSections({ route, width, browser, rootSelector, clock: !arg("no-clock"), motion: !!arg("motion") });
      if (!r.ok || !arg("quiet")) console.log(arg("json") ? JSON.stringify(r) : summarize(r));
      return { route, width, ok: r.ok, sections: r.sections.length, elements: r.sections.reduce((a, x) => a + x.elements, 0), bad: bad(r).length + r.onlyLive.length + r.onlyLocal.length,
        styleDiffs: r.sections.reduce((a, x) => a + x.styleDiffs, 0), maxPx: Math.max(0, ...r.sections.map((x) => x.px ?? 1)) };
    } catch (e) { console.log(`${route} @${width} ERROR ${e.message.split("\n")[0]}`); return { route, width, error: e.message.split("\n")[0] }; }
  });
  await browser.close();
  if (jobs.length > 1) fs.writeFileSync(path.join(ensureDir(OUT_DIR()), "sections-summary.json"), JSON.stringify(all, null, 1));
  console.log(`sections: ${all.length} runs, ok ${all.filter((x) => x.ok).length}, with issues ${all.filter((x) => !x.ok && !x.error).length}, errors ${all.filter((x) => x.error).length}`);
}
