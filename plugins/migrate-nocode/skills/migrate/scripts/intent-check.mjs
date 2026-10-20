// Catches bugs a pixel diff against live cannot see (because live has them too): horizontal scroll, text under the
// fixed/sticky header at load, fixed-height boxes whose text is clipped or spills, dead links (href="#", empty,
// javascript:), social labels that are not links, non-pointer cursors on clickable things, images without size or
// broken, logo centering, state that breaks after a breakpoint round trip, and header contrast while scrolling.
//
// Usage:
//   node tools/migrate/intent-check.mjs [--target local|live|<url>] [--routes /,/about] [--widths 1440,390]
//     [--checks hscroll,header,overflow,links,social,cursor,images,center,resize,contrast] [--skip resize,contrast]
//     [--center "#logo"] [--center-tol 4] [--contrast-steps 5] [--contrast-widths 1440,390] [--concurrency 2] [--max 3] [--strict]
// Default target is local (config.local); use --target live in reconnaissance to list the live site's own bugs.
// Output: short summary; details in <outDir>/intent/<target>.json and resize captures in <outDir>/intent/<target>/<slug>/.
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { config, arg, listArg, numListArg, launch, slugOf } from "./lib/common.mjs";
import { pickRoutes, outPath, writeJson, showText, newPage, gotoPage, scrollThrough, installHelpers, installClock, scrollFn, pool, isMain } from "./lib/qa.mjs";

const ALL = ["hscroll", "header", "overflow", "links", "social", "cursor", "images", "center", "resize", "contrast"];

// ---------- in-page checks ----------

/** Fixed/sticky bars glued to the top of the viewport (outermost only). Runs in the page. */
function findHeadersSrc() {
  window.__qaHeaders = () => {
    const { visible, effOpacity } = window.__qa;
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const cands = [];
    for (const el of document.body.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (!visible(el, { opacity: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 2 || r.bottom <= 4 || r.height > vh * 0.4 || r.width < vw * 0.5) continue;
      if (effOpacity(el) < 0.1) continue;
      cands.push(el);
    }
    return cands.filter((el) => !cands.some((o) => o !== el && o.contains(el)));
  };
}

function atLoad({ center }) {
  const { textBlocks, path, effOpacity } = window.__qa;
  const headers = window.__qaHeaders();
  const textRect = (el) => {
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const rs = [...rg.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    return { top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)), left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)) };
  };
  const fixedAncestor = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const under = [];
  if (headers.length) {
    const blocks = textBlocks(document.body);
    for (const h of headers) {
      const hr = h.getBoundingClientRect();
      for (const b of blocks) {
        if (h.contains(b.el) || b.el.contains(h)) continue;
        const tr = textRect(b.el);
        if (!tr || tr.bottom <= hr.top + 1 || tr.top >= hr.bottom - 1 || tr.right <= hr.left || tr.left >= hr.right) continue;
        if (effOpacity(b.el) < 0.1 || fixedAncestor(b.el)) continue;
        const x = (Math.max(tr.left, hr.left) + Math.min(tr.right, hr.right)) / 2;
        const y = (Math.max(tr.top, hr.top) + Math.min(tr.bottom, hr.bottom)) / 2;
        const topEl = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), Math.max(0, Math.min(innerHeight - 1, y)));
        under.push({ text: b.text.replace(/\s+/g, " ").trim().slice(0, 80), path: path(b.el), header: path(h), overlap: Math.round(Math.min(tr.bottom, hr.bottom) - Math.max(tr.top, hr.top)), covered: !!topEl && h.contains(topEl) });
      }
    }
  }
  let centered = null;
  if (center) {
    let el = null;
    try { el = document.querySelector(center); } catch {}
    if (el) {
      const r = el.getBoundingClientRect();
      centered = { selector: center, dy: Math.round((r.top + r.height / 2 - innerHeight / 2) * 10) / 10, dx: Math.round((r.left + r.width / 2 - document.documentElement.clientWidth / 2) * 10) / 10 };
    } else centered = { selector: center, missing: true };
  }
  return { headers: headers.map((h) => ({ path: path(h), height: Math.round(h.getBoundingClientRect().height) })), under, centered };
}

function staticChecks() {
  const { visible, path, effOpacity, textBlocks } = window.__qa;
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const se = document.scrollingElement || document.documentElement;
  const isSvgInner = (el) => el.tagName.toLowerCase() !== "svg" && !!el.closest("svg");
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || el.querySelector?.("img[alt]")?.getAttribute("alt") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const fixedAncestor = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { if (getComputedStyle(e).position === "fixed") return true; } return false; };
  const out = {};

  // 1. Horizontal scroll: overflow of the document and whether the user can actually pan.
  const sw = Math.max(se.scrollWidth, document.body.scrollWidth);
  const y0 = scrollY;
  window.scrollTo(300, y0);
  const pannable = scrollX > 0;
  window.scrollTo(0, y0);
  const culprits = [];
  if (sw > vw + 1 || pannable) {
    const list = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (isSvgInner(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || (r.right <= vw + 1 && r.left >= -1)) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position === "fixed") { clipped = true; break; }
        if (cs.overflowX !== "visible") { const pr = p.getBoundingClientRect(); if (pr.right <= vw + 1 && pr.left >= -1) { clipped = true; break; } }
      }
      if (!clipped && getComputedStyle(el).position !== "fixed") list.push(el);
      if (list.length > 300) break;
    }
    for (const el of list) if (!list.some((o) => o !== el && o.contains(el))) culprits.push({ el, r: el.getBoundingClientRect() });
    // Text runs overflowing a box that itself fits (long words, labels in a too-narrow grid column).
    if (culprits.length < 5) {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t && culprits.length < 5; t = tw.nextNode()) {
        if (!/\S/.test(t.data) || !t.parentElement || t.parentElement.closest("script,style,noscript,template")) continue;
        const rg = document.createRange();
        rg.selectNodeContents(t);
        const r = [...rg.getClientRects()].find((x) => x.width > 0 && (x.right > vw + 1 || x.left < -1));
        if (!r) continue;
        let clipped = false;
        for (let p = t.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.position === "fixed") { clipped = true; break; }
          if (cs.overflowX !== "visible") { const pr = p.getBoundingClientRect(); if (pr.right <= vw + 1 && pr.left >= -1) { clipped = true; break; } }
        }
        if (!clipped && !culprits.some((c) => c.el.contains(t))) culprits.push({ el: t.parentElement, r, text: t.data.trim().slice(0, 40) });
      }
    }
  }
  out.hscroll = { scrollWidth: sw, clientWidth: vw, pannable, culprits: culprits.slice(0, 5).map(({ el, r, text }) => ({ path: path(el), left: Math.round(r.left), right: Math.round(r.right), ...(text ? { text } : {}) })) };

  // 2. Fixed-height boxes whose text is clipped (overflow hidden/clip) or spills (overflow visible).
  const overflow = [];
  const byText = new Map();
  for (const el of document.body.querySelectorAll("*")) {
    if (isSvgInner(el) || el.closest("script,style,noscript,template,select,textarea")) continue;
    const ch = el.clientHeight;
    if (ch < 8 || el.scrollHeight <= ch + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "inline" || cs.display === "contents" || /auto|scroll/.test(cs.overflowY)) continue;
    if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") continue;
    if (cs.textOverflow === "ellipsis") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2 || !visible(el)) continue;
    const clips = cs.overflowY === "hidden" || cs.overflowY === "clip";
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let t = tw.nextNode(); t && n < 400; t = tw.nextNode(), n++) {
      if (!/\S/.test(t.data)) continue;
      const p = t.parentElement;
      if (!p || !visible(p, { opacity: true }) || effOpacity(p) < 0.1) continue;
      // Text inside an absolutely positioned descendant (dropdown, tooltip) is placed on purpose.
      let abs = false;
      for (let e = p; e && e !== el; e = e.parentElement) { const pos = getComputedStyle(e).position; if (pos === "absolute" || pos === "fixed") { abs = true; break; } }
      if (abs) continue;
      const rg = document.createRange();
      rg.selectNodeContents(t);
      const rs = [...rg.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      const over = rs.filter((x) => x.bottom > r.bottom + 2);
      if (!over.length) continue;
      byText.set(t, { el, clips, beyond: Math.round(Math.max(...over.map((x) => x.bottom)) - r.bottom), text: t.data.replace(/\s+/g, " ").trim().slice(0, 60) });
    }
  }
  // Innermost box per text node, then one entry per box. "Fixed" = the box grows when height/max-height are released.
  const boxes = new Map();
  for (const v of byText.values()) if (!boxes.has(v.el) || v.beyond > boxes.get(v.el).beyond) boxes.set(v.el, v);
  for (const [el, v] of boxes) {
    const before = el.getBoundingClientRect().height;
    const old = el.getAttribute("style");
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("max-height", "none", "important");
    const after = el.getBoundingClientRect().height;
    if (old === null) el.removeAttribute("style"); else el.setAttribute("style", old);
    const fixed = after > before + 1;
    if (!v.clips && !fixed) continue;
    overflow.push({ path: path(el), kind: v.clips ? "clipped" : "spills", fixed, height: Math.round(before), contentHeight: Math.round(after), beyond: v.beyond, text: v.text });
    if (overflow.length >= 30) break;
  }
  out.overflow = overflow;

  // 3. Links: href="#", empty, javascript:, missing target, platform/dev URLs.
  const PLATFORM = /\.webflow\.io|\.framer\.(website|app|ai|media|photos)|framer\.com\/(projects|sites)|\.ycode\.(site|app)|app\.ycode\.com|\/wp-admin|\/wp-login|localhost:|127\.0\.0\.1|\.vercel\.app|\.netlify\.app|\bstaging\./i;
  const links = [];
  for (const a of document.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    const vis = visible(a);
    let issue = null;
    if (href === null) { if ((a.id || a.getAttribute("name")) && !a.textContent.trim()) continue; if (vis && (a.textContent.trim() || a.querySelector("img,svg"))) issue = "no-href"; }
    else if (href.trim() === "") issue = "empty";
    else if (href.trim() === "#") issue = "hash";
    else if (/^\s*javascript:/i.test(href)) issue = "javascript";
    else if (/^#./.test(href) && href !== "#top") { let id = href.slice(1); try { id = decodeURIComponent(id); } catch {} if (!document.getElementById(id) && !document.getElementsByName(id).length) issue = "missing-anchor"; }
    else if (PLATFORM.test(href)) issue = "platform-url";
    if (issue) links.push({ issue, href, text: label(a), path: path(a), visible: vis });
  }
  out.links = links;

  // 4. Social network labels that are not links (or link somewhere else).
  const NETS = {
    linkedin: /linkedin\.com|lnkd\.in/i, instagram: /instagram\.com|instagr\.am/i, behance: /behance\.net/i, x: /(^|\.|\/)(x|twitter)\.com/i,
    twitter: /(^|\.|\/)(x|twitter)\.com/i, facebook: /facebook\.com|fb\.com|fb\.me/i, youtube: /youtube\.com|youtu\.be/i, tiktok: /tiktok\.com/i,
    dribbble: /dribbble\.com/i, whatsapp: /wa\.me|whatsapp\.com/i, threads: /threads\.(net|com)/i, pinterest: /pinterest\./i, vimeo: /vimeo\.com/i,
    github: /github\.com/i, medium: /medium\.com/i, spotify: /spotify\.com/i, telegram: /t\.me\/|telegram\./i,
  };
  const ALIAS = { xtwitter: "x", twitterx: "x", ig: "instagram", insta: "instagram", fb: "facebook", yt: "youtube", wpp: "whatsapp", zap: "whatsapp" };
  const netOf = (s) => { const k = String(s || "").toLowerCase().replace(/[^\p{L}]/gu, ""); const n = ALIAS[k] || k; return NETS[n] ? n : null; };
  const social = [];
  const seenSocial = new Set();
  const cands = [];
  for (const b of textBlocks(document.body)) if (b.text.trim().length <= 24) cands.push([b.el, b.text]);
  for (const el of document.querySelectorAll("img[alt], svg[aria-label], [aria-label]")) cands.push([el, el.getAttribute("alt") || el.getAttribute("aria-label")]);
  for (const t of document.querySelectorAll("svg > title")) cands.push([t.parentElement, t.textContent]);
  for (const [el, text] of cands) {
    const net = netOf(text);
    if (!net || seenSocial.has(el) || !visible(el)) continue;
    if (net === "x" && String(text).trim() !== "X" && !/twitter/i.test(text)) continue;
    seenSocial.add(el);
    const a = el.closest("a[href]");
    if (!a) {
      if (el.closest("button,[role=link],[onclick]")) social.push({ issue: "button-not-link", net, text: String(text).trim(), path: path(el) });
      else social.push({ issue: "not-a-link", net, text: String(text).trim(), path: path(el) });
    } else {
      const href = a.getAttribute("href") || "";
      if (!/^#/.test(href) && !/^\s*javascript:/i.test(href) && href.trim() && !NETS[net].test(href)) social.push({ issue: "points-elsewhere", net, text: String(text).trim(), href, path: path(a) });
    }
  }
  out.social = social;

  // 5. Cursor of clickable things (what the pointer shows over the element's center when it is in the viewport).
  const cursor = { checked: 0, bad: [], custom: 0, covered: [] };
  for (const el of document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button], input[type=reset], summary')) {
    if (!visible(el, { opacity: true }) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    cursor.checked++;
    let target = el;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
      const t = document.elementFromPoint(cx, cy);
      if (t && (t === el || el.contains(t))) target = t;
      else if (t && !t.contains(el) && !fixedAncestor(t) && cursor.covered.length < 20) cursor.covered.push({ path: path(el), text: label(el), by: path(t) });
    }
    const cur = getComputedStyle(target).cursor;
    if (cur === "pointer") continue;
    if (cur === "none" || /^url\(/.test(cur)) { cursor.custom++; continue; }
    if (cursor.bad.length < 40) cursor.bad.push({ tag: el.tagName.toLowerCase(), cursor: cur, text: label(el), path: path(el) });
    else cursor.bad.push(null);
  }
  cursor.badCount = cursor.bad.length;
  cursor.bad = cursor.bad.filter(Boolean);
  out.cursor = cursor;

  // 6. Images: broken, no width/height (layout shift), oversized.
  const images = { checked: 0, broken: [], missingDims: [], oversized: [] };
  const base = (s) => (s || "").split("?")[0].split("/").pop().slice(0, 60);
  for (const img of document.images) {
    if (!visible(img)) continue;
    images.checked++;
    const src = img.currentSrc || img.getAttribute("src") || "";
    if (!src) continue;
    const cs = getComputedStyle(img);
    if (img.complete && img.naturalWidth === 0 && !/\.svg(\?|$)/i.test(src)) { images.broken.push({ src: base(src), path: path(img) }); continue; }
    const sized = cs.aspectRatio !== "auto" || cs.position === "absolute" || cs.position === "fixed" || cs.objectFit !== "fill" || /height/.test(img.getAttribute("style") || "");
    if (!sized && images.missingDims.length < 200) images.missingDims.push({ src: base(src), path: path(img) });
    const rw = img.getBoundingClientRect().width;
    if (img.naturalWidth > 1600 && img.naturalWidth > rw * devicePixelRatio * 2.5 && images.oversized.length < 50) images.oversized.push({ src: base(src), natural: img.naturalWidth, rendered: Math.round(rw) });
  }
  out.images = images;
  return out;
}

// ---------- contrast of the fixed header while scrolling ----------

const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };

/** Foreground = pixels that change when the item is hidden (strongest 40%), background = median of the hidden capture. */
function itemContrast(A, B, rect) {
  const fg = [], bg = [];
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(A.width, Math.ceil(rect.x + rect.w)), y1 = Math.min(A.height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * A.width + x) * 4;
    const a = [A.data[i], A.data[i + 1], A.data[i + 2]], b = [B.data[i], B.data[i + 1], B.data[i + 2]];
    const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    bg.push(b);
    if (d > 60) fg.push({ c: a, d });
  }
  if (!bg.length) return null;
  if (fg.length < 3) return { contrast: 1, fgPixels: fg.length };
  fg.sort((p, q) => q.d - p.d);
  const top = fg.slice(0, Math.max(3, Math.ceil(fg.length * 0.4)));
  const mean = [0, 1, 2].map((k) => top.reduce((s, p) => s + p.c[k], 0) / top.length);
  bg.sort((p, q) => lum(p) - lum(q));
  const med = bg[Math.floor(bg.length / 2)];
  return { contrast: ratio(mean, med), fgPixels: fg.length, fg: mean.map(Math.round), bg: med };
}

async function contrastCheck(page, steps) {
  const total = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  const ys = steps <= 1 ? [0] : [...new Set(Array.from({ length: steps }, (_, i) => Math.round((total * i) / (steps - 1))))];
  const samples = [];
  for (const y of ys) {
    await page.evaluate(scrollFn, y);
    await page.waitForTimeout(650);
    const info = await page.evaluate(() => {
      const { visible, textBlocks, path, rgba } = window.__qa;
      const h = window.__qaHeaders()[0];
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      const clip = { x: Math.max(0, Math.floor(hr.left)), y: Math.max(0, Math.floor(hr.top)), width: Math.floor(Math.min(document.documentElement.clientWidth, hr.right) - Math.max(0, hr.left)), height: Math.floor(Math.min(innerHeight, hr.bottom) - Math.max(0, hr.top)) };
      if (clip.width < 10 || clip.height < 10) return null;
      const items = [];
      for (const b of textBlocks(h)) items.push([b.el, b.text.replace(/\s+/g, " ").trim().slice(0, 40)]);
      for (const el of h.querySelectorAll("svg, img")) if (!el.parentElement.closest("svg")) items.push([el, el.getAttribute("alt") || el.getAttribute("aria-label") || el.tagName.toLowerCase()]);
      for (const el of h.querySelectorAll("span, div, i")) { // burger bars: small leaf boxes with a background
        if (el.children.length || el.textContent.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > 4000 || r.width < 8 || rgba(getComputedStyle(el).backgroundColor)[3] < 0.5) continue;
        items.push([el, "bar"]);
      }
      const out = [];
      for (const [el, label] of items.slice(0, 24)) {
        if (!visible(el, { opacity: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom <= hr.top || r.top >= hr.bottom) continue;
        el.setAttribute("data-qa-item", String(out.length));
        el.setAttribute("data-qa-vis", el.style.getPropertyValue("visibility") || "");
        out.push({ label, path: path(el), x: r.left - clip.x, y: r.top - clip.y, w: r.width, h: r.height });
      }
      return { clip, items: out, header: path(h) };
    });
    if (!info) { samples.push({ y, header: false }); continue; }
    const A = PNG.sync.read(await page.screenshot({ clip: info.clip, animations: "disabled" }));
    await page.evaluate(() => { for (const el of document.querySelectorAll("[data-qa-item]")) el.style.setProperty("visibility", "hidden", "important"); });
    await page.waitForTimeout(80);
    const B = PNG.sync.read(await page.screenshot({ clip: info.clip, animations: "disabled" }));
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("[data-qa-item]")) {
        const v = el.getAttribute("data-qa-vis");
        if (v) el.style.setProperty("visibility", v); else el.style.removeProperty("visibility");
        el.removeAttribute("data-qa-item"); el.removeAttribute("data-qa-vis");
        if (el.getAttribute("style") === "") el.removeAttribute("style");
      }
    });
    const items = info.items.map((it) => ({ label: it.label, path: it.path, ...(itemContrast(A, B, it) || {}) })).filter((it) => it.contrast !== undefined);
    samples.push({ y, header: info.header, items });
  }
  return samples;
}

// ---------- resize round trip ----------

/** Rects of the root's children + header + document size: what must be identical after desktop → mobile → desktop. */
async function fingerprint(page, root) {
  return page.evaluate((root) => {
    const r0 = window.__qa.root(root);
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top + scrollY), Math.round(r.left), Math.round(r.width), Math.round(r.height)]; };
    return {
      docHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
      kids: [...r0.children].filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK)$/.test(el.tagName)).map((el) => ({ path: window.__qa.path(el), box: box(el), vis: window.__qa.visible(el) })),
      headers: window.__qaHeaders().map((h) => ({ path: window.__qa.path(h), box: box(h) })),
    };
  }, root);
}

/** Pixels that differ between two captures, excluding a dilated noise mask (what moves on its own). */
function diffOutsideNoise(a, b, noise, dilate = 8) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const crop = (img) => { if (img.width === w && img.height === h) return img; const o = new PNG({ width: w, height: h }); PNG.bitblt(img, o, 0, 0, w, h, 0, 0); return o; };
  const A = crop(a), B = crop(b), N = noise ? crop(noise) : null;
  const d = new PNG({ width: w, height: h });
  pixelmatch(A.data, B.data, d.data, w, h, { threshold: 0.1, includeAA: false, diffMask: true });
  let mask = null;
  if (N) {
    const dn = new PNG({ width: w, height: h });
    pixelmatch(A.data, N.data, dn.data, w, h, { threshold: 0.1, includeAA: false, diffMask: true });
    // Box dilation with prefix sums (O(w*h)).
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = dn.data[i * 4 + 3] > 0 && dn.data[i * 4] === 255 && dn.data[i * 4 + 1] === 0 ? 1 : 0;
    const sum = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += m[y * w + x]; sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row; } }
    mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - dilate), xb = Math.min(w, x + dilate + 1), ya = Math.max(0, y - dilate), yb = Math.min(h, y + dilate + 1);
      if (sum[yb * (w + 1) + xb] - sum[ya * (w + 1) + xb] - sum[yb * (w + 1) + xa] + sum[ya * (w + 1) + xa] > 0) mask[y * w + x] = 1;
    }
  }
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const on = d.data[i * 4 + 3] > 0 && d.data[i * 4] === 255 && d.data[i * 4 + 1] === 0;
    if (!on) { d.data[i * 4 + 3] = 0; continue; }
    if (mask && mask[i]) { d.data[i * 4] = 255; d.data[i * 4 + 1] = 200; d.data[i * 4 + 2] = 0; d.data[i * 4 + 3] = 80; continue; }
    n++;
  }
  return { ratio: Math.round((n / (w * h)) * 1e5) / 1e5, pixels: n, diff: d, noisePixels: mask ? mask.reduce((s, v) => s + v, 0) : 0 };
}

/**
 * Desktop → mobile → desktop on page A; page B (control) stays at desktop. Both run under a paused fake clock advanced
 * by the same amounts, so JS carousels/marquees sit on the same frame; CSS animations are disabled in the captures and
 * what still moves in real time (B captured twice) is masked. Differences left = state broken by the round trip.
 */
async function resizeCheck(browser, url, { dW, mW, root, dir }) {
  const [A, B] = await Promise.all([newPage(browser, dW), newPage(browser, dW)]);
  const both = (fn) => Promise.all([A, B].map(fn));
  const shot = (p) => p.screenshot({ animations: "disabled", caret: "hide" });
  const stillVideos = (p) => p.evaluate(() => { for (const v of document.querySelectorAll("video")) { try { v.pause(); v.currentTime = 0; } catch {} } });
  try {
    await both((p) => installClock(p).catch(() => {}));
    await both((p) => gotoPage(p, url));
    await both(async (p) => { await installHelpers(p); await p.evaluate(findHeadersSrc); await p.clock.runFor(2500).catch(() => {}); });
    await A.setViewportSize({ width: mW, height: 900 });
    await A.clock.runFor(1200).catch(() => {});
    await A.waitForTimeout(400);
    const midBuf = await shot(A);
    await A.setViewportSize({ width: dW, height: 900 });
    await A.clock.runFor(1200).catch(() => {});
    await B.clock.runFor(2400).catch(() => {});
    await both((p) => p.waitForTimeout(600));
    await both(stillVideos);
    const [bufA, bufB1] = await Promise.all([shot(A), shot(B)]);
    await B.waitForTimeout(500);
    const bufB2 = await shot(B);
    const [fA, fB] = await Promise.all([fingerprint(A, root), fingerprint(B, root)]);
    const px = diffOutsideNoise(PNG.sync.read(bufB1), PNG.sync.read(bufA), PNG.sync.read(bufB2));
    const changes = [];
    if (Math.abs(fA.docHeight - fB.docHeight) > 2) changes.push(`document height ${fB.docHeight} → ${fA.docHeight}`);
    if (fA.scrollWidth !== fB.scrollWidth) changes.push(`scrollWidth ${fB.scrollWidth} → ${fA.scrollWidth}`);
    fB.kids.forEach((k, i) => {
      const o = fA.kids[i];
      if (!o) return changes.push(`${k.path} missing after resize`);
      if (k.vis !== o.vis) changes.push(`${k.path} visible ${k.vis} → ${o.vis}`);
      if (Math.max(...k.box.map((v, j) => Math.abs(v - o.box[j]))) > 2) changes.push(`${k.path} [top,left,w,h] ${k.box.join(",")} → ${o.box.join(",")}`);
    });
    fB.headers.forEach((k, i) => { const o = fA.headers[i]; if (!o || Math.max(...k.box.map((v, j) => Math.abs(v - o.box[j]))) > 2) changes.push(`header ${k.path} changed after resize`); });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "resize-control.png"), bufB1);
    fs.writeFileSync(path.join(dir, "resize-mobile.png"), midBuf);
    fs.writeFileSync(path.join(dir, "resize-after.png"), bufA);
    fs.writeFileSync(path.join(dir, "resize-diff.png"), PNG.sync.write(px.diff));
    return { ratio: px.ratio, pixels: px.pixels, noisePixels: px.noisePixels, changes: changes.slice(0, 20), sequence: [dW, mW, dW] };
  } finally {
    await both((p) => p.context().close().catch(() => {}));
  }
}

// ---------- runner ----------

async function checkWidth(browser, url, width, { checks, center, contrastSteps, doContrast }) {
  const page = await newPage(browser, width);
  try {
    const status = await gotoPage(page, url);
    await installHelpers(page);
    await page.evaluate(findHeadersSrc);
    await page.waitForTimeout(1500); // entrance animations
    const load = await page.evaluate(atLoad, { center: checks.has("center") ? center : null });
    await scrollThrough(page, { eager: true });
    await page.waitForTimeout(400);
    const st = await page.evaluate(staticChecks);
    let contrast = null;
    if (doContrast && load.headers.length) contrast = await contrastCheck(page, contrastSteps);
    return { status, ...load, ...st, contrast };
  } catch (e) {
    return { error: String(e.message || e).split("\n")[0] };
  } finally {
    await page.context().close().catch(() => {});
  }
}

/** Turns raw per-width results into findings {check, severity, key, detail}; identical findings merge their widths. */
function findingsOf(route, width, r, { checks, centerTol }) {
  const f = [];
  const add = (check, severity, key, detail) => f.push({ check, severity, route, width, key, detail });
  if (r.error) { add("load", "error", r.error, r.error); return f; }
  if (r.status >= 400) add("load", "error", `HTTP ${r.status}`, `HTTP ${r.status}`);
  if (checks.has("hscroll") && (r.hscroll.scrollWidth > r.hscroll.clientWidth + 1 || r.hscroll.pannable)) {
    const c = r.hscroll.culprits[0];
    add("hscroll", r.hscroll.pannable ? "error" : "warn", "page", `+${r.hscroll.scrollWidth - r.hscroll.clientWidth}px${r.hscroll.pannable ? "" : " (overflow hidden, not pannable)"}${c ? ` ← ${c.text ? `text "${c.text}" in ` : ""}${c.path} (right ${c.right})` : ""}`);
  }
  if (checks.has("header")) for (const u of r.under) add("header", u.covered ? "error" : "warn", u.path, `"${u.text}" ${u.covered ? "under" : "overlaps"} ${u.header} by ${u.overlap}px`);
  if (checks.has("overflow")) for (const o of r.overflow) add("overflow", "error", o.path, `${o.kind} ${o.beyond}px (box ${o.height}px${o.fixed ? `, content ${o.contentHeight}px` : ""}): "${o.text}"`);
  if (checks.has("links")) for (const l of r.links) add("links", ["hash", "empty", "javascript", "platform-url"].includes(l.issue) ? "error" : "warn", `${l.issue}|${l.text}|${l.href}`, `${l.issue} ${l.href === null ? "(no href)" : `href="${l.href}"`} "${l.text}"${l.visible ? "" : " (hidden)"}`);
  if (checks.has("social")) for (const s of r.social) add("social", s.issue === "points-elsewhere" ? "warn" : "error", `${s.issue}|${s.text}`, `${s.net} "${s.text}" ${s.issue}${s.href ? ` (${s.href})` : ""}`);
  if (checks.has("cursor")) {
    for (const b of r.cursor.bad) add("cursor", "error", `${b.tag}|${b.text}|${b.path}`, `${b.tag} "${b.text}" cursor: ${b.cursor}`);
    for (const c of r.cursor.covered) add("cursor", "warn", `covered|${c.path}`, `"${c.text}" covered by ${c.by}`);
  }
  if (checks.has("images")) {
    for (const b of r.images.broken) add("images", "error", `broken|${b.src}`, `broken ${b.src}`);
    if (r.images.missingDims.length) add("images", "warn", "missing-dims", `${r.images.missingDims.length} without width/height or aspect-ratio (e.g. ${r.images.missingDims.slice(0, 2).map((x) => x.src).join(", ")})`);
    if (r.images.oversized.length) add("images", "info", "oversized", `${r.images.oversized.length} oversized (e.g. ${r.images.oversized[0].src} ${r.images.oversized[0].natural}px for ${r.images.oversized[0].rendered}px)`);
  }
  if (checks.has("center") && r.centered) {
    if (r.centered.missing) add("center", "info", "missing", `${r.centered.selector} not found`);
    else if (Math.abs(r.centered.dy) > centerTol || Math.abs(r.centered.dx) > centerTol) add("center", "warn", `${r.centered.dx},${r.centered.dy}`, `${r.centered.selector} off center: dy ${r.centered.dy}px dx ${r.centered.dx}px`);
  }
  if (r.contrast) {
    const worst = new Map();
    for (const s of r.contrast) for (const it of s.items || []) { const k = it.path; if (!worst.has(k) || it.contrast < worst.get(k).contrast) worst.set(k, { ...it, y: s.y }); }
    // One finding per route × width: the items below 3:1, worst first, and the scroll positions where it happens.
    const low = [...worst.values()].filter((it) => it.contrast < 3).sort((a, b) => a.contrast - b.contrast);
    if (low.length) {
      const ys = [...new Set(r.contrast.filter((s) => (s.items || []).some((it) => it.contrast < 3)).map((s) => s.y))];
      add("contrast", low[0].contrast < 1.5 ? "error" : "warn", "header", `${low.length} header item(s) below 3:1, worst "${low[0].label}" ${low[0].contrast}:1 (${low.slice(1, 4).map((x) => `"${x.label}" ${x.contrast}`).join(", ")}${low.length > 4 ? "…" : ""}) at scroll ${ys.join(", ")}px`);
    }
  }
  return f;
}

function mergeFindings(list) {
  const m = new Map();
  for (const f of list) {
    const k = `${f.check}|${f.route}|${f.key}`;
    if (!m.has(k)) m.set(k, { ...f, widths: [f.width] });
    else { const x = m.get(k); if (!x.widths.includes(f.width)) x.widths.push(f.width); if (f.severity === "error") x.severity = "error"; }
  }
  for (const x of m.values()) { delete x.width; delete x.key; }
  return [...m.values()];
}

export async function run() {
  const c = config();
  const targetArg = String(arg("target", "local"));
  const base = targetArg === "live" ? c.live : targetArg === "local" ? c.local : targetArg.replace(/\/$/, "");
  const target = targetArg === "live" || targetArg === "local" ? targetArg : new URL(base).host;
  const widths = numListArg("widths", c.widths).sort((a, b) => b - a);
  let checks = new Set(listArg("checks", ALL));
  for (const s of listArg("skip")) checks.delete(s);
  const center = arg("center") && arg("center") !== true ? String(arg("center")) : null;
  if (!center) checks.delete("center");
  const centerTol = Number(arg("center-tol", 4));
  const contrastSteps = Number(arg("contrast-steps", 5));
  const contrastWidths = numListArg("contrast-widths", [widths[0], widths.at(-1)]);
  const routes = pickRoutes();
  const max = Number(arg("max", 3));
  const browser = await launch();
  const raw = [];
  let findings = [];
  try {
    const jobs = routes.flatMap((route) => widths.map((width) => ({ route, width })));
    const conc = Number(arg("concurrency", 2));
    const res = await pool(jobs, conc, async ({ route, width }) => {
      const r = await checkWidth(browser, base + route, width, { checks, center, contrastSteps, doContrast: checks.has("contrast") && contrastWidths.includes(width) });
      return { route, width, r };
    });
    for (const { route, width, r } of res) { raw.push({ route, width, ...r }); findings.push(...findingsOf(route, width, r, { checks, centerTol })); }
    if (checks.has("resize") && widths.length > 1) {
      const rs = await pool(routes, conc, async (route) => {
        const dir = outPath("intent", target, slugOf(route));
        try { return { route, ...(await resizeCheck(browser, base + route, { dW: widths[0], mW: widths.at(-1), root: c.rootSelector, dir })) }; } catch (e) { return { route, error: String(e.message || e).split("\n")[0] }; }
      });
      for (const r of rs) {
        raw.push({ route: r.route, resize: r });
        if (r.error) findings.push({ check: "resize", severity: "warn", route: r.route, width: widths[0], key: "error", detail: r.error });
        else if (r.ratio > 0.005 || r.changes.length) findings.push({ check: "resize", severity: "error", route: r.route, width: widths[0], key: "resize", detail: `${widths[0]}→${widths.at(-1)}→${widths[0]}: ${(r.ratio * 100).toFixed(2)}% pixels changed${r.changes.length ? `; ${r.changes[0]}` : ""}` });
      }
    }
  } finally {
    await browser.close();
  }
  findings = mergeFindings(findings);
  const file = outPath("intent", `${target}.json`);
  const rel = writeJson(file, { target, base, at: new Date().toISOString(), widths, routes, checks: [...checks], findings, raw });
  // Summary: one line per check, a few samples.
  const errors = findings.filter((f) => f.severity === "error").length, warns = findings.filter((f) => f.severity === "warn").length;
  console.log(`intent-check: ${target} (${base}), ${routes.length} routes × ${widths.length} widths — ${errors} errors, ${warns} warnings`);
  for (const check of ["load", ...ALL]) {
    const list = findings.filter((f) => f.check === check && f.severity !== "info");
    const info = findings.filter((f) => f.check === check && f.severity === "info");
    if (!list.length && !info.length) continue;
    const e = list.filter((f) => f.severity === "error").length;
    console.log(`  ${check.padEnd(9)} ${String(list.length).padStart(3)}${e ? ` (${e} errors)` : ""}${info.length ? ` +${info.length} info` : ""}`);
    for (const f of [...list.sort((a, b) => (a.severity === "error" ? -1 : 1) - (b.severity === "error" ? -1 : 1)), ...info].slice(0, max)) {
      console.log(`    ${f.severity === "error" ? "✗" : f.severity === "warn" ? "!" : "·"} ${f.route} @${f.widths.join(",")}: ${showText(f.detail, 110)}`);
    }
  }
  console.log(`JSON: ${rel}`);
  if (arg("strict") && errors) process.exitCode = 1;
  return { findings, file };
}

if (isMain(import.meta.url)) {
  run().catch((e) => { console.error("intent-check:", e.message); process.exit(1); });
}
