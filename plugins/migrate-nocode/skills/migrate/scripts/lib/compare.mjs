// Shared helpers for the comparison tools (measure, sections, crop, states, motion, run-all).
// Everything here is platform-agnostic: platform specifics come from migrate.config.json via common.mjs.
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { config, mirrorFile } from "./common.mjs";

export const VIEW_H = 900;

/** Hides dev overlays (Next.js indicator, toasts) and the text caret on both sides. */
export const PREP_CSS = `
nextjs-portal, [data-nextjs-toast], #__next-build-watcher, [data-next-badge-root], [data-nextjs-dev-tools-button], #__next-route-announcer__ { display:none !important; }
*, *::before, *::after { caret-color: transparent !important; }`;

/** Same instant on both sides and across runs of one process (rounded to the minute, close to real time so
 *  sites that compare Date.now() with server time keep working). */
const CLOCK_T0 = Math.floor(Date.now() / 60000) * 60000;

/** Carousel/marquee tracks whose x position depends on the animation phase (x/transform not compared). */
export const DEFAULT_PHASE_SELECTORS = [
  ".swiper-wrapper", ".splide__list", ".slick-track", ".flickity-slider", ".glide__slides", ".embla__container",
  ".w-slider-mask", "[class*=marquee]", "[class*=Marquee]", "[class*=ticker]", "[data-framer-name*=Ticker]", "[data-framer-name*=Marquee]",
];
export const phaseSelectors = () => [...DEFAULT_PHASE_SELECTORS, ...(config().phaseSelectors || [])].join(",");

/** New context + page at the given width (viewport height 900, DPR 1). bypassCSP lets us inject styles everywhere. */
export async function newPage(browser, width, height = VIEW_H) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true, reducedMotion: "no-preference" });
  return ctx.newPage();
}

/** Scrolls the window and any known smooth-scroll instance (Lenis, GSAP ScrollSmoother, Locomotive). Runs in the page. */
export function scrollFn(y) {
  window.scrollTo(0, y);
  for (const k of ["lenis", "__lenis", "_lenis", "lenisInstance", "_holyLenis", "smoothScroll"]) {
    try { window[k]?.scrollTo?.(y, { immediate: true, force: true }); } catch {}
  }
  try { window.ScrollSmoother?.get?.()?.scrollTo?.(y, false); } catch {}
  try { window.locomotiveScroll?.scrollTo?.(y, { duration: 0, disableLerp: true }); } catch {}
}

/** Installs a paused fake clock. Retries with a later pause target when Playwright says
 *  "Cannot fast-forward to the past" (the installed clock already ran past the target). */
export async function installClock(page) {
  await page.clock.install({ time: new Date(CLOCK_T0) });
  for (let k = 0; k < 6; k++) {
    try { await page.clock.pauseAt(new Date(CLOCK_T0 + 1000 * 4 ** k)); return; } catch (e) {
      if (!/fast-forward to the past/i.test(e.message) || k === 5) throw e;
    }
  }
}
export const isClockPastError = (e) => /fast-forward to the past/i.test(String(e?.message || e));

/**
 * Serves fonts to the LIVE side from the local mirror (public/_m/...) when the live font host fails or is slow.
 * Only fonts that already have a mirrored file are intercepted; everything else goes straight to the network.
 */
export async function routeFontsFromMirror(page, { timeout = 8000 } = {}) {
  try { config(); } catch { return []; }
  const served = [];
  await page.route(/\.(woff2?|otf|ttf)(\?|$)/i, async (route) => {
    const url = route.request().url();
    let file = null;
    try { file = mirrorFile(url); } catch {}
    if (!file || !fs.existsSync(file)) return route.continue();
    const ext = path.extname(file).slice(1).toLowerCase();
    const fromMirror = () => { served.push(url); return route.fulfill({ path: file, contentType: `font/${ext}`, headers: { "access-control-allow-origin": "*" } }); };
    try {
      let timer;
      const res = await Promise.race([route.fetch({ timeout }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("slow")), timeout); timer.unref?.(); })]).finally(() => clearTimeout(timer));
      if (res.status() >= 400) return fromMirror();
      return route.fulfill({ response: res });
    } catch { return fromMirror(); }
  });
  return served;
}

/** In-page helpers (installed once per document): rendered RGBA colors, effective opacity, absolute rects. */
const HELPERS_SRC = `(() => {
  if (window.__migrateCmp) return true;
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  // Rendered color as integer RGBA: lab()/oklab()/rgb() strings of the same color compare equal
  // (Lightning CSS rewrites colors, so the computed string is never compared).
  const rgba = (c) => {
    if (!c || !/(rgb|lab|lch|color|hsl|hwb|#)/i.test(c)) return c;
    if (cache.has(c)) return cache.get(c);
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    const v = "rgba(" + d[0] + "," + d[1] + "," + d[2] + "," + Math.round((d[3] / 255) * 100) / 100 + ")";
    cache.set(c, v); return v;
  };
  // Colors embedded in longer values (box-shadow, gradients, filters).
  const normColors = (s) => typeof s === "string" ? s.replace(/(?:rgba?|oklab|oklch|lab|lch|hsla?|hwb|color)\\([^()]*\\)/gi, (m) => rgba(m)) : s;
  const effOpacity = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return Math.round(o * 100) / 100; };
  const abs = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
  const rectsOf = (sel) => { if (!sel) return []; try { return [...document.querySelectorAll(sel)].map((e) => abs(e.getBoundingClientRect())).filter((r) => r.w > 0 && r.h > 0); } catch { return []; } };
  const gifRects = () => [...document.images].filter((im) => /\\.gif(\\?|$)/i.test(im.currentSrc || im.src)).map((im) => abs(im.getBoundingClientRect())).filter((r) => r.w > 0 && r.h > 0);
  window.__migrateCmp = { rgba, normColors, effOpacity, abs, rectsOf, gifRects };
  return true;
})()`;
export const ensureHelpers = (page) => page.evaluate(HELPERS_SRC);

/**
 * Opens the page and brings it to a reproducible rest state:
 * paused fake clock (JS animations on the same frame on both sides), full scroll to trigger animations and lazy load,
 * paused videos, real image loads (with reloads of failed images), all fonts loaded, infinite animations frozen.
 * opts.side: "live" | "local" (local gets window[staticFlag] = true unless motion; live gets the font fallback).
 */
export async function preparePage(page, url, { side = "live", settle = 1800, clock = true, scroll = true, motion = false } = {}) {
  const c = config();
  const tick = async (ms) => (clock ? page.clock.runFor(ms) : page.waitForTimeout(ms));
  if (side === "live") await routeFontsFromMirror(page);
  if (side === "local" && !motion && c.staticFlag) await page.addInitScript((flag) => { window[flag] = true; }, c.staticFlag);
  if (clock) await installClock(page);
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.addStyleTag({ content: PREP_CSS }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await tick(2500); // entrance (load) animations
  if (scroll) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const step = Math.max(200, Math.floor((page.viewportSize()?.height || VIEW_H) * 0.6));
    for (let y = 0; y <= total; y += step) {
      await page.evaluate(scrollFn, y);
      // Let images triggered by this scroll finish loading (real time) BEFORE advancing the clock: scripts that start
      // timers on image load then start them at the same fake instant on both sides.
      await waitImages(page, 12, false);
      await tick(150);
    }
    await page.evaluate(scrollFn, 1e7);
    await tick(500);
  }
  await page.evaluate(scrollFn, 0);
  await tick(500);
  await page.evaluate(() => {
    for (const v of document.querySelectorAll("video")) { try { v.autoplay = false; v.pause(); v.currentTime = 0; } catch {} }
    for (const img of document.querySelectorAll("img[loading=lazy]")) img.loading = "eager";
  });
  await waitImages(page);
  // Videos: wait (real time) until the first frame is decoded, otherwise one side shows black.
  for (let i = 0; i < 20; i++) {
    const pending = await page.evaluate(() => [...document.querySelectorAll("video")].filter((v) => v.preload !== "none" && (v.currentSrc || v.querySelector("source")) && v.readyState < 2 && !v.error && v.networkState !== 3).length);
    if (!pending) break;
    await page.waitForTimeout(250);
  }
  await tick(settle);
  // Force every declared @font-face to load (a cold server otherwise captures with the fallback font).
  await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => null))); await document.fonts.ready; });
  await page.waitForTimeout(700); // CSS transitions run on real time
  await freezeAnimations(page);
  await ensureHelpers(page);
}

/** Waits (real time, not the fake clock) until images really loaded: naturalWidth > 0, because img.complete is
 *  also true for FAILED images. Failed images are reloaded up to 3 times. */
export async function waitImages(page, rounds = 60, retryBroken = true) {
  for (let i = 0; i < rounds; i++) {
    const { pending, broken } = await page.evaluate((retry) => {
      const imgs = [...document.images].filter((im) => im.currentSrc || im.getAttribute("src"));
      const broken = imgs.filter((im) => im.complete && im.naturalWidth === 0 && !/\.svg(\?|$)/i.test(im.currentSrc || im.src) && !(im.getAttribute("src") || "").startsWith("data:"));
      if (retry) for (const im of broken) { const n = Number(im.dataset.measureRetry || 0); if (n < 3) { im.dataset.measureRetry = String(n + 1); const s = im.src; im.src = ""; im.src = s; } }
      return { pending: imgs.filter((im) => !im.complete).length, broken: broken.filter((im) => Number(im.dataset.measureRetry || 0) < 3).length };
    }, retryBroken && i % 8 === 7);
    if (!pending && (!broken || !retryBroken)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** Infinite WAAPI/CSS animations do not follow the fake clock: pause them all at the same instant (1 s) on both sides.
 *  Long finite animations still running are finished (their end state is what both sides converge to). */
export async function freezeAnimations(page, at = 1000) {
  return page.evaluate((at) => {
    let inf = 0, fin = 0;
    for (const a of document.getAnimations()) {
      const t = a.effect?.getComputedTiming?.();
      if (!t) continue;
      if (t.iterations === Infinity || t.endTime === Infinity) { try { a.pause(); a.currentTime = at; inf++; } catch {} }
      else if (a.playState === "running") { try { a.finish(); fin++; } catch {} }
    }
    return { infinite: inf, finished: fin };
  }, at);
}

/** Full-page capture. Images are decoded first (decoding="async" can paint blank beyond the viewport) and
 *  will-change is neutralized during the capture (Chromium paints filtered layers wrong beyond the viewport). */
export async function fullShot(page) {
  await page.evaluate(() => Promise.all([...document.images].map((im) => (im.naturalWidth ? im.decode().catch(() => null) : null))));
  const h = await page.addStyleTag({ content: "*, *::before, *::after { will-change: auto !important; }" }).catch(() => null);
  await page.waitForTimeout(50);
  const buf = await page.screenshot({ fullPage: true, animations: "allow", caret: "hide" });
  if (h) await h.evaluate((el) => el.remove()).catch(() => {});
  return buf;
}

/** Selectors of dynamic regions for a route: config.dynamicRegions = [{route: "*" | "/x" | "/blog/*" | "^regex", selector}]. */
export function dynamicRegions(route) {
  const list = config().dynamicRegions || [];
  const entries = Array.isArray(list) ? list : Object.entries(list).filter(([k]) => !k.startsWith("_")).flatMap(([k, v]) => [].concat(v).map((selector) => ({ route: k, selector })));
  const match = (r) => {
    if (!r || r === "*") return true;
    if (r.startsWith("^")) return new RegExp(r).test(route);
    if (r.includes("*")) return new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(route);
    return r.replace(/\/$/, "") === route.replace(/\/$/, "") || (r === "/" && route === "/");
  };
  return entries.filter((e) => match(e.route)).flatMap((e) => [].concat(e.selector || e.selectors || []));
}

/** Copy of the local PNG with the rows below `cut` (live coordinate) pulled up by `delta` px (local[y + delta]). */
export function alignBelow(localPng, cut, delta) {
  const B = PNG.sync.read(localPng);
  const O = new PNG({ width: B.width, height: Math.max(1, B.height - Math.max(0, delta)) });
  for (let y = 0; y < O.height; y++) {
    const src = y < cut ? y : y + delta;
    if (src < 0 || src >= B.height) continue;
    B.data.copy(O.data, y * B.width * 4, src * B.width * 4, (src + 1) * B.width * 4);
  }
  return PNG.sync.write(O);
}

const round = (v, n = 6) => Math.round(v * 10 ** n) / 10 ** n;

/**
 * Pixel diff of two captures (cropped to the common size). Writes the raw diff to outDiff.
 * masks: rects (live coordinates) copied from live onto local before the masked comparison (GIFs, dynamic regions);
 * alignedLocalPng: local capture realigned below a dynamic region (see alignBelow).
 * Ratios are fractions (0..1).
 */
export function screenshotDiff(livePng, localPng, outDiff, { band = 400, masks = [], alignedLocalPng = null } = {}) {
  const A = PNG.sync.read(livePng), B = PNG.sync.read(localPng);
  const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
  const crop = (img) => { const o = new PNG({ width: w, height: h }); PNG.bitblt(img, o, 0, 0, w, h, 0, 0); return o; };
  const a = crop(A), b = crop(B), d = new PNG({ width: w, height: h });
  const opts = { threshold: 0.1, includeAA: false };
  const n = pixelmatch(a.data, b.data, d.data, w, h, opts);
  let nMasked = n, dm = d;
  if (masks.length || alignedLocalPng) {
    const b2 = new PNG({ width: w, height: h });
    if (alignedLocalPng) { const AL = PNG.sync.read(alignedLocalPng); PNG.bitblt(AL, b2, 0, 0, Math.min(w, AL.width), Math.min(h, AL.height), 0, 0); } else b.data.copy(b2.data);
    for (const m of masks) for (let y = Math.max(0, Math.floor(m.y)); y < Math.min(h, Math.ceil(m.y + m.h)); y++) for (let x = Math.max(0, Math.floor(m.x)); x < Math.min(w, Math.ceil(m.x + m.w)); x++) { const i = (y * w + x) * 4; b2.data[i] = a.data[i]; b2.data[i + 1] = a.data[i + 1]; b2.data[i + 2] = a.data[i + 2]; b2.data[i + 3] = a.data[i + 3]; }
    dm = new PNG({ width: w, height: h });
    nMasked = pixelmatch(a.data, b2.data, dm.data, w, h, opts);
  }
  if (outDiff) fs.writeFileSync(outDiff, PNG.sync.write(d));
  const isRed = (img, i) => img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 0;
  const bands = [];
  for (let y0 = 0; y0 < h; y0 += band) {
    const y1 = Math.min(h, y0 + band);
    let c = 0, cm = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (isRed(d, i)) c++; if (isRed(dm, i)) cm++; }
    bands.push({ y0, y1, ratio: round(c / (w * (y1 - y0))), ratioMasked: round(cm / (w * (y1 - y0))) });
  }
  return { ratio: round(n / (w * h)), ratioMasked: round(nMasked / (w * h)), masks: masks.length, comparedHeight: h, comparedWidth: w, liveHeight: A.height, localHeight: B.height, bands };
}

/** live | gap | local, same height (min of both), magenta divider. */
export function sideBySide(a, b, gap = 8) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  const h = Math.min(A.height, B.height), w = A.width + gap + B.width;
  const o = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { o.data[i * 4] = 255; o.data[i * 4 + 1] = 0; o.data[i * 4 + 2] = 255; o.data[i * 4 + 3] = 255; }
  PNG.bitblt(A, o, 0, 0, A.width, h, 0, 0);
  PNG.bitblt(B, o, 0, 0, B.width, h, A.width + gap, 0);
  return PNG.sync.write(o);
}

/** Runs async jobs with a fixed concurrency. */
export async function pool(items, concurrency, fn) {
  const queue = [...items];
  const results = [];
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) { const it = queue.shift(); results.push(await fn(it)); }
  }));
  return results;
}

/** Default pixel tolerance for "ok" (fraction of differing pixels after masks). */
export const pixelTolerance = () => Number(config().pixelTolerance ?? 0.003);

/** True when the module is the entry script (robust to symlinks such as /tmp -> /private/tmp). */
export function isMain(metaUrl) {
  try { return fs.realpathSync(new URL(metaUrl).pathname) === fs.realpathSync(process.argv[1]); } catch { return false; }
}
