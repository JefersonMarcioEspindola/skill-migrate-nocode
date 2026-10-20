// Samples animations over time (or over scroll), live vs local.
// Usage: node tools/migrate/motion.mjs --route / --width 1440 --selectors "#logo,.hero h1,[data-layer-id=lyr-x]"
//        [--mode load|scroll] [--duration 3000] [--interval 50] [--scroll-to 1200] [--scroll-steps 20] [--real] [--rows 25]
// load:   fake clock installed paused before navigation; t=0 right after "load", each sample advances --interval.
// scroll: waits for the load to settle (preparePage without the full scroll), scrolls 0 -> --scroll-to in
//         --scroll-steps steps, advancing --interval of clock per step.
// --real: real time (waitForTimeout) instead of the fake clock; required for CSS transitions/animations.
// Per selector (first match): opacity (own and effective), decomposed transform (tx, ty, sx, sy, rot), visibility,
// display, filter, clip-path and the bounding rect (top, left, w, h).
// Output: compact table per selector + verdict; full samples in <outDir>/<slug>/<width>/motion-<mode>[-real].json
import fs from "node:fs";
import path from "node:path";
import { config, OUT_DIR, slugOf, ensureDir, launch, arg } from "./lib/common.mjs";
import { preparePage, newPage, installClock, seedRandom, routeFontsFromMirror, scrollFn, PREP_CSS, isMain } from "./lib/compare.mjs";

const NUM = ["o", "eo", "tx", "ty", "sx", "sy", "rot", "top", "left", "w", "h"];
const TOL = { o: 0.01, eo: 0.01, sx: 0.005, sy: 0.005, rot: 0.5 }; // others (px): 0.5
const tol = (k) => TOL[k] ?? 0.5;
const ALL = ["o", "eo", "tx", "ty", "sx", "sy", "rot", "vis", "disp", "filter", "clip", "top", "left", "w", "h"];

/** Reads the state of each selector in the page. */
function sampleIn(sels) {
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  const decompose = (t) => {
    if (!t || t === "none") return { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
    const m = t.match(/matrix(3d)?\(([^)]+)\)/);
    if (!m) return { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0, raw: t };
    const v = m[2].split(",").map(Number);
    const [a, b, c, d, e, f] = m[1] ? [v[0], v[1], v[4], v[5], v[12], v[13]] : v;
    const sx = Math.hypot(a, b), sy = sx ? (a * d - b * c) / sx : 0;
    return { tx: r1(e), ty: r1(f), sx: r3(sx), sy: r3(sy), rot: r1((Math.atan2(b, a) * 180) / Math.PI) };
  };
  const out = {};
  for (const sel of sels) {
    let el = null;
    try { el = document.querySelector(sel); } catch {}
    if (!el) { out[sel] = null; continue; }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    let eo = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) eo *= Number(getComputedStyle(e).opacity);
    out[sel] = { o: r3(Number(cs.opacity)), eo: r3(eo), ...decompose(cs.transform), vis: cs.visibility, disp: cs.display, filter: cs.filter, clip: cs.clipPath, top: r1(r.top), left: r1(r.left), w: r1(r.width), h: r1(r.height) };
  }
  return { scrollY: Math.round(scrollY), v: out };
}

export async function sampleMotion({ browser, url, side, width, selectors, mode = "load", real = false, duration = 3000, interval = 50, scrollTo = 1200, scrollSteps = 20, motion = false }) {
  const c = config();
  const page = await newPage(browser, width);
  const samples = [];
  try {
    const t0 = Date.now();
    const take = async (t) => { const s = await page.evaluate(sampleIn, selectors); samples.push({ t: real ? Date.now() - t0 : t, ...s }); };
    const advance = (ms) => (real ? page.waitForTimeout(ms) : page.clock.runFor(ms));
    if (mode === "load") {
      await routeFontsFromMirror(page);
      if (side === "local" && c.staticFlag && !motion) await page.addInitScript((f) => { window[f] = true; }, c.staticFlag);
      await seedRandom(page);
      if (!real) await installClock(page);
      await page.goto(url, { waitUntil: real ? "domcontentloaded" : "load", timeout: 90000 });
      await page.addStyleTag({ content: PREP_CSS }).catch(() => {});
      if (!real) await page.evaluate(() => document.fonts.ready); // in real time we do not wait: the animation is already running
      const tStart = Date.now();
      for (let t = 0; t <= duration; t += interval) { await take(t); await advance(interval); }
      if (real) for (const s of samples) s.t -= tStart - t0; // t relative to the start of sampling
    } else {
      await preparePage(page, url, { side, clock: !real, scroll: false, motion });
      const n = Math.max(1, scrollSteps);
      for (let i = 0; i <= n; i++) {
        await page.evaluate(scrollFn, Math.round((scrollTo * i) / n));
        await advance(interval);
        await take(i * interval);
      }
    }
  } finally { await page.context().close().catch(() => {}); }
  return samples;
}

const fmt = (v, keys) => (v ? keys.map((k) => `${k}=${v[k]}`).join(" ") : "∅");
const same = (a, b, k) => (NUM.includes(k) ? Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)) <= tol(k) : a?.[k] === b?.[k]);

/** First and last change over time (vs the previous sample). */
function changes(series, ts) {
  let first = null, last = null;
  for (let i = 1; i < series.length; i++) if (ALL.some((k) => !same(series[i - 1], series[i], k))) { first ??= ts[i]; last = ts[i]; }
  return { first, last };
}

/** Verdict per selector: {selector, foundLive, foundLocal, startDiff, endDiff, maxDiff, stringDiffs, live, local}. */
export function verdict(SL, SC, selectors, { mode, real, interval }) {
  const n = Math.min(SL.length, SC.length);
  return selectors.map((sel) => {
    const L = SL.slice(0, n).map((s) => s.v[sel]), C = SC.slice(0, n).map((s) => s.v[sel]);
    const ts = SL.slice(0, n).map((s, i) => (mode === "scroll" ? s.scrollY : real ? `${s.t}/${SC[i].t}` : s.t));
    const diffAt = (i) => (L[i] && C[i] ? ALL.filter((k) => !same(L[i], C[i], k)) : ["missing"]);
    const maxDiff = {};
    for (let i = 0; i < n; i++) for (const k of NUM) { if (!L[i] || !C[i]) continue; const d = Math.abs(L[i][k] - C[i][k]); if (d > tol(k) && d > (maxDiff[k] ?? 0)) maxDiff[k] = Math.round(d * 1000) / 1000; }
    const stringDiffs = ["vis", "disp", "filter", "clip"].filter((k) => L.some((v, i) => v && C[i] && v[k] !== C[i][k]));
    return { selector: sel, L, C, ts, foundLive: L.some(Boolean), foundLocal: C.some(Boolean), startDiff: diffAt(0), endDiff: diffAt(n - 1), maxDiff, stringDiffs, live: changes(L, ts), local: changes(C, ts), interval };
  });
}

if (isMain(import.meta.url)) {
  const c = config();
  const route = arg("route", "/");
  const width = Number(arg("width", 1440));
  const mode = arg("mode", "load");
  const real = !!arg("real");
  const opts = { width, mode, real, duration: Number(arg("duration", 3000)), interval: Number(arg("interval", 50)), scrollTo: Number(arg("scroll-to", 1200)), scrollSteps: Number(arg("scroll-steps", 20)), motion: !!arg("motion") };
  const maxRows = Number(arg("rows", 25));
  const selectors = String(arg("selectors", "h1")).split(/,(?![^[]*\])(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  const outDir = ensureDir(path.join(OUT_DIR(), slugOf(route), String(width)));
  const browser = await launch();
  const [SL, SC] = await Promise.all([
    sampleMotion({ ...opts, browser, selectors, side: "live", url: c.live + (arg("live-route") || route) }),
    sampleMotion({ ...opts, browser, selectors, side: "local", url: c.local + (arg("local-route") || route) }),
  ]);
  await browser.close();
  const file = path.join(outDir, `motion-${mode}${real ? "-real" : ""}.json`);
  const V = verdict(SL, SC, selectors, opts);
  fs.writeFileSync(file, JSON.stringify({ route, ...opts, selectors, at: new Date().toISOString(), verdict: V.map(({ L, C, ts, ...v }) => v), live: SL, local: SC }));
  const out = [`motion ${route} @${width} mode ${mode} ${real ? "REAL TIME (includes CSS; t approximate, paired by index)" : "fake clock (JS only: GSAP/rAF/timers; CSS transitions/animations do NOT follow it, use --real)"}`];
  out.push(mode === "load" ? `  ${opts.duration}ms every ${opts.interval}ms` : `  scroll 0→${opts.scrollTo} in ${opts.scrollSteps} steps, +${opts.interval}ms per step`);
  const n = Math.min(SL.length, SC.length);
  for (const v of V) {
    const { L, C, ts } = v;
    out.push(`\n${v.selector}`);
    if (!v.foundLive || !v.foundLocal) { out.push(`  not found: ${!v.foundLive ? "live " : ""}${!v.foundLocal ? "local" : ""}`); if (!v.foundLive && !v.foundLocal) continue; }
    const varying = ALL.filter((k) => [L, C].some((ser) => ser.some((x, i) => i && !same(ser[i - 1], x, k))));
    const keys = varying.length ? varying : ["o", "tx", "ty"];
    if (!varying.length) out.push(`  no change over time on either side`);
    else {
      const rows = [0];
      for (let i = 1; i < n; i++) if (keys.some((k) => !same(L[i - 1], L[i], k) || !same(C[i - 1], C[i], k))) rows.push(i);
      if (rows.at(-1) !== n - 1) rows.push(n - 1);
      let shown = rows;
      if (rows.length > maxRows) { const st = (rows.length - 1) / (maxRows - 1); shown = [...new Set(Array.from({ length: maxRows }, (_, j) => rows[Math.round(j * st)]))]; }
      out.push(`  ${mode === "scroll" ? "scrollY" : "t(ms)"} | live | local${shown.length < rows.length ? `   (${shown.length} of ${rows.length} rows with changes)` : ""}`);
      for (const i of shown) out.push(`  ${String(ts[i]).padStart(5)} | ${fmt(L[i], keys)} | ${fmt(C[i], keys)}`);
    }
    const span = (ch) => (ch.first == null ? "static" : `changes ${ch.first} to ${ch.last}${mode === "scroll" || real ? "" : ` (≈${ch.last - ch.first + opts.interval}ms, delay ${ch.first - opts.interval}ms)`}`);
    out.push(`  start ${v.startDiff.length ? "DIFFERS (" + v.startDiff.join(",") + ")" : "equal"} | end ${v.endDiff.length ? "DIFFERS (" + v.endDiff.join(",") + ")" : "equal"}`);
    out.push(`  max |live-local|: ${Object.keys(v.maxDiff).length ? Object.entries(v.maxDiff).map(([k, x]) => `${k} ${x}`).join(", ") : "within tolerance"}${v.stringDiffs.length ? "; strings differ: " + v.stringDiffs.join(",") : ""}`);
    out.push(`  live ${span(v.live)} | local ${span(v.local)}`);
  }
  out.push(`\nsamples: ${path.relative(process.cwd(), file)}`);
  console.log(out.join("\n"));
}
