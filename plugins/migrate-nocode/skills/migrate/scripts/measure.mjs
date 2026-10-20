// Measures one route at one width, live site vs local Next.js app, in a headless browser.
// Usage: node tools/migrate/measure.mjs --route /about --width 1440 [--live-route /about] [--local-route /about]
//        [--no-clock] [--motion] [--json] [--max 40]
// Output: <outDir>/<slug>/<width>/{live.png,local.png,diff.png,report.json}
// Pairing: texts by content (n-th occurrence), controls by label, media by order (icons < 40px ignored).
// The accumulated vertical offset is discounted: y is reported only when the jump differs from the previous pair.
import fs from "node:fs";
import path from "node:path";
import { config, OUT_DIR, slugOf, ensureDir, launch, arg, pct } from "./lib/common.mjs";
import {
  preparePage, fullShot, dynamicRegions, alignBelow, screenshotDiff, newPage, ensureHelpers, isClockPastError, pixelTolerance, PREP_CSS, isMain,
} from "./lib/compare.mjs";

export { preparePage, fullShot, dynamicRegions, PREP_CSS };

export const BASE_PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "color", "lineHeight", "letterSpacing", "textAlign", "textTransform", "textDecorationLine",
  "borderTopWidth", "borderTopStyle", "borderTopColor", "borderBottomWidth", "borderRadius", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "columnGap", "rowGap", "backgroundColor", "backgroundImage", "opacity", "objectFit", "boxShadow", "whiteSpace", "mixBlendMode"];

/**
 * Extracts measurable elements with computed styles (absolute page coordinates).
 * opts: extraProps (extra computed props), scope (root selector), includeHidden (hidden elements and small media),
 *       boxes (elements without text that carry an id or config.idAttribute: kind "box", key "#id" / "[attr=v]"),
 *       dynamic (selectors excluded from pairing), idAttribute.
 */
export async function extract(page, { extraProps = [], scope = null, includeHidden = false, boxes = false, dynamic = [], idAttribute = config().idAttribute } = {}) {
  await ensureHelpers(page);
  return page.evaluate(({ props, scope, includeHidden, boxes, dynamic, idAttribute }) => {
    const { rgba, normColors, effOpacity, rectsOf, gifRects } = window.__migrateCmp;
    const COLOR_PROPS = new Set(["color", "borderTopColor", "backgroundColor", "outlineColor", "textDecorationColor"]);
    const COLORISH = new Set(["boxShadow", "backgroundImage", "textShadow", "filter"]);
    const out = [];
    const visible = (cs, r) => r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    const sy = scrollY, sx = scrollX;
    let root = null;
    try { root = scope ? document.querySelector(scope) : document.body; } catch {}
    const all = !root ? [] : scope ? [root, ...root.querySelectorAll("*")] : root.querySelectorAll("*");
    let dynSel = dynamic.filter((s) => { try { document.querySelector(s); return true; } catch { return false; } }).join(",");
    for (const el of all) {
      if (dynSel && el.closest(dynSel)) continue; // dynamic region (content changes per visit): out of pairing
      if (el.closest("nextjs-portal,script,style,noscript,template,head")) continue;
      const tag = el.tagName.toLowerCase();
      if (el.parentElement?.closest("svg")) continue; // svg internals
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!includeHidden && !visible(cs, r)) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
      let kind = null, key = null;
      if (tag === "img" || tag === "video" || tag === "picture" || tag === "canvas" || tag === "iframe" || tag === "svg") {
        if (!includeHidden && r.width < 40 && r.height < 40) continue; // icons
        if (tag === "picture") continue;
        kind = "media";
        key = tag + ":" + ((el.currentSrc || el.getAttribute("src") || "").split("/").pop().split("?")[0] || "");
      } else if (own) {
        kind = "text"; key = own.slice(0, 120);
      } else if (["a", "button", "input", "select", "textarea", "label"].includes(tag)) {
        kind = "control"; key = tag + ":" + (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || el.textContent.replace(/\s+/g, " ").trim().slice(0, 60));
      } else if (boxes && (el.id || (idAttribute && el.getAttribute(idAttribute)))) {
        kind = "box"; key = el.id ? "#" + el.id : `[${idAttribute}="${el.getAttribute(idAttribute)}"]`;
      } else continue;
      const style = {};
      for (const p of props) style[p] = COLOR_PROPS.has(p) ? rgba(cs[p]) : COLORISH.has(p) ? normColors(cs[p]) : cs[p];
      out.push({ i: out.length, kind, key, tag, x: Math.round((r.left + sx) * 10) / 10, y: Math.round((r.top + sy) * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, op: effOpacity(el), style });
    }
    return {
      docHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyBg: rgba(getComputedStyle(document.body).backgroundColor),
      htmlBg: rgba(getComputedStyle(document.documentElement).backgroundColor),
      dynRects: rectsOf(dynSel),
      // Animated GIFs: the frame shown depends on load time (declared exception); masked in the pixel diff.
      gifRects: gifRects(),
      elements: out,
      scopeFound: !!root,
    };
  }, { props: [...new Set([...extraProps, ...BASE_PROPS])], scope, includeHidden, boxes, dynamic, idAttribute });
}

/**
 * Pairs texts/controls by key (n-th occurrence) and media by order.
 * Duplicated keys (tabs, carousels, cloned slides) are paired visible-with-visible first, then hidden-with-hidden
 * (effective opacity 0), then whatever is left in document order: a carousel that reorders its hidden copies in the
 * DOM must not produce "opacity 1→0 / 0→1" swaps.
 */
export function pair(live, local) {
  const pairs = [], onlyLive = [], onlyLocal = [];
  const group = (list) => { const m = new Map(); for (const e of list) { if (!m.has(e.key)) m.set(e.key, []); m.get(e.key).push(e); } return m; };
  const shown = (e) => e.op > 0.01;
  for (const kind of ["text", "control"]) {
    const L = group(live.filter((e) => e.kind === kind)), C = group(local.filter((e) => e.kind === kind));
    for (const [key, ls] of L) {
      const cs = C.get(key) || [];
      C.delete(key);
      if (ls.length === 1 && cs.length === 1) { pairs.push([ls[0], cs[0]]); continue; }
      const restL = [], restC = [];
      for (const vis of [true, false]) {
        const a = ls.filter((e) => shown(e) === vis), b = cs.filter((e) => shown(e) === vis);
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) pairs.push([a[i], b[i]]);
        restL.push(...a.slice(n)); restC.push(...b.slice(n));
      }
      const byDoc = (x, y) => x.i - y.i;
      restL.sort(byDoc); restC.sort(byDoc);
      const n = Math.min(restL.length, restC.length);
      for (let i = 0; i < n; i++) pairs.push([restL[i], restC[i]]);
      onlyLive.push(...restL.slice(n)); onlyLocal.push(...restC.slice(n));
    }
    for (const cs of C.values()) onlyLocal.push(...cs);
  }
  const lm = live.filter((e) => e.kind === "media"), cm = local.filter((e) => e.kind === "media");
  for (let i = 0; i < Math.max(lm.length, cm.length); i++) {
    if (lm[i] && cm[i]) pairs.push([lm[i], cm[i]]); else if (lm[i]) onlyLive.push(lm[i]); else onlyLocal.push(cm[i]);
  }
  pairs.sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x);
  return { pairs, onlyLive, onlyLocal };
}

/**
 * Differences per pair. y is reported only when the vertical jump (local.y - live.y) changes versus the previous
 * pair: content above that is taller on one side pushes everything down, and that is ONE divergence, not hundreds.
 * Returns [{kind, key, tag, y, localY, props: [{prop, live, local, jump?}]}].
 */
export function diffPairs(pairs, tol = 1) {
  const diffs = [];
  let prevDy = 0;
  for (const [a, b] of pairs) {
    const d = [];
    const dy = b.y - a.y;
    if (Math.abs(dy - prevDy) > tol) d.push({ prop: "y", live: a.y, local: b.y, jump: Math.round((dy - prevDy) * 10) / 10 });
    prevDy = dy;
    for (const k of ["x", "w", "h"]) if (Math.abs(a[k] - b[k]) > tol) d.push({ prop: k, live: a[k], local: b[k] });
    if (Math.abs(a.op - b.op) > 0.02) d.push({ prop: "opacity(effective)", live: a.op, local: b.op });
    for (const p of Object.keys(a.style)) if (a.style[p] !== b.style[p]) d.push({ prop: p, live: a.style[p], local: b.style[p] });
    if (d.length) diffs.push({ kind: a.kind, key: a.key, tag: a.tag, y: a.y, localY: b.y, props: d });
  }
  return diffs;
}

/** Text form of one property difference. */
export const fmtProp = (p) => (p.prop === "y" ? `y ${p.live}→${p.local} (jump ${p.jump})` : `${p.prop} ${p.live}→${p.local}`);

async function measureOnce({ route, width, liveRoute = route, localRoute = route, outDir, browser, clock = true, motion = false }) {
  const c = config();
  const own = !browser;
  browser ||= await launch();
  const liveUrl = c.live + liveRoute, localUrl = c.local + localRoute;
  const [pl, pc] = await Promise.all([newPage(browser, width), newPage(browser, width)]);
  try {
    await Promise.all([preparePage(pl, liveUrl, { side: "live", clock }), preparePage(pc, localUrl, { side: "local", clock, motion })]);
    const dynamic = dynamicRegions(route);
    const [L, C] = await Promise.all([extract(pl, { dynamic }), extract(pc, { dynamic })]);
    const [sl, sc] = await Promise.all([fullShot(pl), fullShot(pc)]);
    ensureDir(outDir);
    fs.writeFileSync(path.join(outDir, "live.png"), sl);
    fs.writeFileSync(path.join(outDir, "local.png"), sc);
    const exceptions = [];
    // Below a dynamic region whose height changed, the local capture is realigned by the delta before the masked %.
    const sumH = (rs) => rs.reduce((a, r) => a + r.h, 0);
    const dynDelta = Math.round(sumH(C.dynRects) - sumH(L.dynRects));
    const cut = L.dynRects.length ? Math.round(Math.max(...L.dynRects.map((r) => r.y + r.h))) : 0;
    const aligned = dynDelta && cut ? alignBelow(sc, cut, dynDelta) : null;
    const masks = [...L.gifRects, ...C.gifRects, ...L.dynRects, ...C.dynRects];
    const px = screenshotDiff(sl, sc, path.join(outDir, "diff.png"), { masks, alignedLocalPng: aligned });
    if (L.gifRects.length + C.gifRects.length) exceptions.push({ type: "gif-mask", count: L.gifRects.length + C.gifRects.length, detail: "animated GIF areas masked in ratioMasked" });
    if (L.dynRects.length + C.dynRects.length) exceptions.push({ type: "dynamic-region", selectors: dynamic, count: L.dynRects.length + C.dynRects.length, heightDelta: dynDelta, detail: "excluded from pairing, masked in ratioMasked, content below realigned" });
    const stableHeight = { live: Math.round(L.docHeight - sumH(L.dynRects)), local: Math.round(C.docHeight - sumH(C.dynRects)) };
    const { pairs, onlyLive, onlyLocal } = pair(L.elements, C.elements);
    let elDiffs = diffPairs(pairs);
    // A y jump equal to the dynamic region's height delta is explained (content picked per visit), not a divergence.
    if (dynDelta) {
      elDiffs = elDiffs.filter((d) => {
        const onlyY = d.props.length === 1 && d.props[0].prop === "y";
        if (onlyY && Math.abs(d.props[0].jump - dynDelta) <= 1.5) { exceptions.push({ type: "explained-shift", key: d.key, y: d.y, jump: d.props[0].jump, detail: `dynamic region ${dynDelta}px` }); return false; }
        return true;
      });
    }
    const diffs = [];
    for (const d of elDiffs) for (const p of d.props) diffs.push({ key: d.key, kind: d.kind, tag: d.tag, y: d.y, prop: p.prop, live: p.live, local: p.local, ...(p.jump !== undefined ? { jump: p.jump } : {}) });
    for (const e of onlyLive) diffs.push({ key: e.key, kind: e.kind, tag: e.tag, y: e.y, prop: "presence", live: "present", local: "missing" });
    for (const e of onlyLocal) diffs.push({ key: e.key, kind: e.kind, tag: e.tag, y: e.y, prop: "presence", live: "missing", local: "present" });
    const heightOk = L.docHeight === C.docHeight || (L.dynRects.length > 0 && stableHeight.live === stableHeight.local);
    const hscroll = C.scrollWidth > C.clientWidth && C.scrollWidth !== L.scrollWidth;
    const pixRatio = masks.length || aligned ? px.ratioMasked : px.ratio;
    const report = {
      route, liveRoute, localRoute, width, at: new Date().toISOString(), clock, motion,
      live: { url: liveUrl, height: L.docHeight, stableHeight: stableHeight.live, scrollWidth: L.scrollWidth, clientWidth: L.clientWidth, bodyBg: L.bodyBg },
      local: { url: localUrl, height: C.docHeight, stableHeight: stableHeight.local, scrollWidth: C.scrollWidth, clientWidth: C.clientWidth, bodyBg: C.bodyBg },
      pixels: px,
      counts: { live: L.elements.length, local: C.elements.length, paired: pairs.length, onlyLive: onlyLive.length, onlyLocal: onlyLocal.length, elementsWithDiffs: elDiffs.length },
      diffs, divergences: diffs.length, exceptions,
      checks: { height: heightOk, hscroll: !hscroll, bodyBg: L.bodyBg === C.bodyBg, pixels: pixRatio < pixelTolerance() },
    };
    report.ok = report.divergences === 0 && Object.values(report.checks).every(Boolean);
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1));
    return report;
  } finally {
    await pl.context().close().catch(() => {});
    await pc.context().close().catch(() => {});
    if (own) await browser.close();
  }
}

/** measure({route, width, browser?, outDir?, liveRoute?, localRoute?, clock?, motion?}) -> report (also written to outDir). */
export async function measure(opts) {
  const outDir = opts.outDir || path.join(OUT_DIR(), slugOf(opts.route), String(opts.width));
  for (let attempt = 0; ; attempt++) {
    try { return await measureOnce({ ...opts, outDir }); } catch (e) {
      if (attempt < 2 && isClockPastError(e)) continue; // fake clock race: retry the whole measurement
      throw e;
    }
  }
}

/** Short terminal summary. */
export function summarize(r, max = 30) {
  const hb = r.pixels.bands.filter((b) => b.ratioMasked > 0.003).slice(0, 12).map((b) => `${b.y0}-${b.y1}:${pct(b.ratioMasked)}`).join(" ");
  const masked = r.pixels.masks ? ` (masked ${pct(r.pixels.ratioMasked)})` : "";
  const lines = [
    `${r.ok ? "OK " : "-- "}${r.route} @${r.width}  height ${r.live.height}/${r.local.height}  scrollW ${r.live.scrollWidth}/${r.local.scrollWidth}  px ${pct(r.pixels.ratio)}${masked}  paired ${r.counts.paired}  divergences ${r.divergences} (only-live ${r.counts.onlyLive}, only-local ${r.counts.onlyLocal})`,
  ];
  if (!r.checks.bodyBg) lines.push(`  body bg ${r.live.bodyBg} → ${r.local.bodyBg}`);
  if (!r.checks.hscroll) lines.push(`  HORIZONTAL SCROLL on local: scrollWidth ${r.local.scrollWidth} > ${r.local.clientWidth}`);
  if (hb) lines.push(`  bands > 0.3%: ${hb}`);
  const byEl = new Map();
  for (const d of r.diffs) { const k = `${d.kind}|${d.key}|${d.y}`; if (!byEl.has(k)) byEl.set(k, []); byEl.get(k).push(d); }
  for (const [, ds] of [...byEl].slice(0, max)) {
    const d0 = ds[0];
    const txt = d0.prop === "presence" ? `only ${d0.live === "present" ? "live" : "local"}` : ds.slice(0, 6).map(fmtProp).join("; ");
    lines.push(`  [${d0.kind}] "${String(d0.key).slice(0, 50)}" y=${d0.y}: ${txt}`);
  }
  if (byEl.size > max) lines.push(`  … ${byEl.size - max} more elements in report.json`);
  return lines.join("\n");
}

if (isMain(import.meta.url)) {
  const route = arg("route", "/");
  const width = Number(arg("width", 1440));
  const r = await measure({ route, width, liveRoute: arg("live-route", route), localRoute: arg("local-route", route), clock: !arg("no-clock"), motion: !!arg("motion") });
  console.log(arg("json") ? JSON.stringify(r) : summarize(r, Number(arg("max", 30))));
  console.log(`  files: ${path.relative(process.cwd(), path.join(OUT_DIR(), slugOf(route), String(width)))}/`);
}
