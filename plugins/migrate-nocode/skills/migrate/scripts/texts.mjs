// Compares every visible text of each route: live × local (rendered, Playwright) or snapshot × snapshot (offline,
// parse5) to see what the client changed on live during the migration. Also flags placeholder/default texts,
// code leaks, text in the wrong language for the route's locale, duplicated words and filename-like alts.
//
// Usage:
//   node tools/migrate/texts.mjs [--routes /,/about] [--width 1440] [--concurrency 3]      live × local
//   node tools/migrate/texts.mjs --from snapshots/2026-10-01 --to snapshots/2026-10-19      snapshot × snapshot
//   node tools/migrate/texts.mjs --only live|local|<snapdir> [--routes ...]                 flags of one side only
//   [--ignore-selectors ".cookie,.ticker"] [--max 3] [--out name]
// Output: short summary; details in <outDir>/texts/<name>.json
//   routes[]: { route, lang, added[{cat,text}], removed[{cat,text}], changed[{cat,from,to,kind}], flags[{cat,text,flag,detail,inherited}] }
// Categories: text (rendered block text), head (title, description, OG/Twitter), alt, placeholder, aria (aria-label), button.
// NBSP is significant: "a b" vs "a b" is reported as a change of kind "nbsp" (shown as ⍽ in the terminal).
import fs from "node:fs";
import path from "node:path";
import { config, arg, listArg, launch, slugOf } from "./lib/common.mjs";
import {
  pickRoutes, localeOf, outPath, writeJson, normText, showText, similarity, detectLang, contentFlags, parseHtml, walk, getAttr,
  querySelector, matches, newPage, gotoPage, scrollThrough, installHelpers, pool, NOISE_SELECTORS, dynamicSelectors, manifestEntries, isMain,
} from "./lib/qa.mjs";

const CATS = ["head", "text", "alt", "placeholder", "aria", "button"];

// ---------- extraction: rendered page ----------

/** Rendered strings of one page, grouped by category, in document order. */
export async function extractRendered(page, { root, skip = [] }) {
  await installHelpers(page);
  return page.evaluate(({ root, skip }) => {
    const { textBlocks } = window.__qa;
    const skipSel = skip.filter((s) => { try { document.querySelector(s); return true; } catch { return false; } }).join(",");
    const r = window.__qa.root(root);
    const out = { lang: document.documentElement.lang || "", head: [], text: [], alt: [], placeholder: [], aria: [], button: [] };
    const meta = (sel) => document.querySelector(sel)?.getAttribute("content");
    const push = (cat, label, v) => { if (v != null && String(v).trim()) out[cat].push(label ? `${label}: ${v}` : String(v)); };
    push("head", "title", document.title);
    for (const [label, sel] of [["description", 'meta[name="description"]'], ["og:title", 'meta[property="og:title"]'], ["og:description", 'meta[property="og:description"]'],
      ["og:image:alt", 'meta[property="og:image:alt"]'], ["og:site_name", 'meta[property="og:site_name"]'], ["twitter:title", 'meta[name="twitter:title"]'],
      ["twitter:description", 'meta[name="twitter:description"]']]) push("head", label, meta(sel));
    for (const b of textBlocks(r, skipSel)) out.text.push(b.text);
    const inScope = (el) => !el.closest("script,style,noscript,template") && !(skipSel && el.closest(skipSel));
    for (const el of r.querySelectorAll("img[alt]")) if (inScope(el)) push("alt", null, el.getAttribute("alt"));
    for (const el of r.querySelectorAll("[placeholder]")) if (inScope(el)) push("placeholder", null, el.getAttribute("placeholder"));
    for (const el of r.querySelectorAll("[aria-label]")) if (inScope(el)) push("aria", null, el.getAttribute("aria-label"));
    for (const el of r.querySelectorAll('button, [role=button], input[type=submit], input[type=button], input[type=reset]')) {
      if (!inScope(el)) continue;
      push("button", null, el.tagName === "INPUT" ? el.value : el.innerText || el.getAttribute("aria-label"));
    }
    return out;
  }, { root, skip });
}

// ---------- extraction: saved HTML (offline) ----------

const INLINE = new Set("a abbr b bdi bdo br cite code data del dfn em font i img ins kbd label mark q s samp small span strong sub sup time u var wbr svg picture source".split(" "));
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "svg", "iframe", "textarea", "select", "option", "title"]);

/** Same categories from an HTML string (no layout: blocks by tag, hidden = [hidden] or inline display:none). */
export function extractHtml(html, { root, skip = [] }) {
  const doc = parseHtml(html);
  const out = { lang: "", head: [], text: [], alt: [], placeholder: [], aria: [], button: [] };
  const htmlEl = querySelector(doc, "html");
  out.lang = (htmlEl && getAttr(htmlEl, "lang")) || "";
  const push = (cat, label, v) => { if (v != null && String(v).trim()) out[cat].push(label ? `${label}: ${v}` : String(v)); };
  const title = querySelector(doc, "title");
  push("head", "title", title?.childNodes?.map((c) => c.value || "").join(""));
  for (const [label, sel] of [["description", 'meta[name="description"]'], ["og:title", 'meta[property="og:title"]'], ["og:description", 'meta[property="og:description"]'],
    ["og:image:alt", 'meta[property="og:image:alt"]'], ["og:site_name", 'meta[property="og:site_name"]'], ["twitter:title", 'meta[name="twitter:title"]'],
    ["twitter:description", 'meta[name="twitter:description"]']]) { const m = querySelector(doc, sel); if (m) push("head", label, getAttr(m, "content")); }
  const r = (root && querySelector(doc, root)) || querySelector(doc, "body") || doc;
  const skipSel = skip.join(",");
  const hidden = (n) => getAttr(n, "hidden") !== undefined || /display\s*:\s*none/i.test(getAttr(n, "style") || "") || (skipSel && matches(n, skipSel));
  // Block text: text nodes collected up to the nearest block ancestor.
  const blocks = [];
  const visit = (n, cur) => {
    for (const c of n.tagName === "template" ? [] : n.childNodes || []) {
      if (c.nodeName === "#text") { cur.parts.push(c.value); continue; }
      if (!c.tagName || SKIP_TAGS.has(c.tagName) || hidden(c)) continue;
      if (c.tagName === "br") { cur.parts.push(" "); continue; }
      if (INLINE.has(c.tagName)) visit(c, cur);
      else { const b = { parts: [] }; blocks.push(b); visit(c, b); }
    }
  };
  const top = { parts: [] };
  blocks.push(top);
  visit(r, top);
  for (const b of blocks) { const t = b.parts.join(""); if (/\S/.test(t)) out.text.push(t); }
  for (const n of walk(r)) {
    if (!n.tagName || SKIP_TAGS.has(n.tagName)) continue;
    let inSkip = false;
    for (let p = n; p && p.tagName; p = p.parentNode) if ((p !== n && SKIP_TAGS.has(p.tagName)) || (skipSel && matches(p, skipSel))) { inSkip = true; break; }
    if (inSkip) continue;
    if (n.tagName === "img" && getAttr(n, "alt") !== undefined) push("alt", null, getAttr(n, "alt"));
    if (getAttr(n, "placeholder") !== undefined) push("placeholder", null, getAttr(n, "placeholder"));
    if (getAttr(n, "aria-label") !== undefined) push("aria", null, getAttr(n, "aria-label"));
    const type = getAttr(n, "type");
    if (n.tagName === "button" || getAttr(n, "role") === "button") push("button", null, textOf(n) || getAttr(n, "aria-label"));
    else if (n.tagName === "input" && /^(submit|button|reset)$/i.test(type || "")) push("button", null, getAttr(n, "value"));
  }
  return out;
}

const textOf = (n) => [...walk(n)].filter((c) => c.nodeName === "#text").map((c) => c.value).join(" ");

// ---------- comparison ----------

const keyOf = (s) => normText(s);

function changeKind(a, b) {
  const sp = (s) => s.replace(/[  ]/g, " ");
  if (sp(a) === sp(b)) return "nbsp";
  if (a.toLowerCase() === b.toLowerCase()) return "case";
  if (a.replace(/\s/g, "") === b.replace(/\s/g, "")) return "whitespace";
  if (a.replace(/[^\p{L}\p{N}]/gu, "") === b.replace(/[^\p{L}\p{N}]/gu, "")) return "punctuation";
  return "text";
}

/** Multiset diff per category (order-insensitive), then removed/added pairs that look alike become "changed". */
export function diffStrings(A, B) {
  const added = [], removed = [], changed = [];
  for (const cat of CATS) {
    const a = (A[cat] || []).map(keyOf).filter(Boolean), b = (B[cat] || []).map(keyOf).filter(Boolean);
    const count = new Map();
    for (const s of a) count.set(s, (count.get(s) || 0) + 1);
    const onlyB = [];
    for (const s of b) { const n = count.get(s) || 0; if (n > 0) count.set(s, n - 1); else onlyB.push(s); }
    const onlyA = [];
    const left = new Map(count);
    for (const s of a) { const n = left.get(s) || 0; if (n > 0) { onlyA.push(s); left.set(s, n - 1); } }
    // Greedy pairing by similarity (best first).
    const cand = [];
    if (onlyA.length * onlyB.length <= 250000) {
      onlyA.forEach((x, i) => onlyB.forEach((y, j) => {
        const sim = changeKind(x, y) === "text" ? similarity(x, y) : 1;
        if (sim >= 0.6) cand.push({ i, j, sim });
      }));
    }
    cand.sort((p, q) => q.sim - p.sim);
    const usedA = new Set(), usedB = new Set();
    for (const c of cand) {
      if (usedA.has(c.i) || usedB.has(c.j)) continue;
      usedA.add(c.i); usedB.add(c.j);
      changed.push({ cat, from: onlyA[c.i], to: onlyB[c.j], kind: changeKind(onlyA[c.i], onlyB[c.j]) });
    }
    onlyA.forEach((s, i) => { if (!usedA.has(i)) removed.push({ cat, text: s }); });
    onlyB.forEach((s, j) => { if (!usedB.has(j)) added.push({ cat, text: s }); });
  }
  return { added, removed, changed };
}

/** Content flags of one side; `other` (the reference side) marks flags that were already there as inherited. */
export function flagsOf(side, { lang, other, offline = false } = {}) {
  const flags = [];
  const seen = new Set();
  const otherKeys = other ? new Set(CATS.flatMap((c) => (other[c] || []).map((s) => c + "\u0000" + keyOf(s)))) : null;
  for (const cat of CATS) {
    for (const raw of side[cat] || []) {
      const text = keyOf(raw);
      if (!text) continue;
      const k = cat + "\u0000" + text;
      if (seen.has(k)) continue;
      seen.add(k);
      // Offline HTML has no layout: whitespace between inline tags may not render, so skip spacing checks there.
      const list = contentFlags(cat === "head" ? text.replace(/^[\w:]+: /, "") : text, cat).filter((f) => !(offline && f.flag === "space-before-punctuation"));
      if (lang && cat !== "aria" && cat !== "placeholder") {
        const body = cat === "head" ? text.replace(/^[\w:]+: /, "") : text;
        const d = detectLang(body, cat === "text" ? 5 : 4);
        if (d && d.lang !== lang && STOP_LANGS.has(lang)) list.push({ flag: "wrong-language", detail: `looks ${d.lang}, route is ${lang}` });
      }
      for (const f of list) flags.push({ cat, text, ...f, ...(otherKeys ? { inherited: otherKeys.has(k) } : {}) });
    }
  }
  return flags;
}
const STOP_LANGS = new Set(["en", "pt", "es", "it", "fr", "de"]);

const langFor = (route, pageLang) => localeOf(route).lang || (pageLang ? pageLang.split(/[-_]/)[0].toLowerCase() : null);

// ---------- modes ----------

async function renderedSides(routes, sides) {
  const c = config();
  const width = Number(arg("width", 1440));
  const conc = Number(arg("concurrency", 3));
  const extra = listArg("ignore-selectors");
  const browser = await launch();
  try {
    return await pool(routes, conc, async (route) => {
      const skip = [...NOISE_SELECTORS, ...dynamicSelectors(route), ...extra];
      const res = {};
      for (const side of sides) {
        const base = side === "live" ? c.live : c.local;
        const page = await newPage(browser, width);
        try {
          const status = await gotoPage(page, base + route);
          await page.waitForTimeout(800);
          await scrollThrough(page, { pause: 80 });
          res[side] = { status, ...(await extractRendered(page, { root: c.rootSelector, skip })) };
        } catch (e) {
          res[side] = { status: 0, error: String(e.message || e).split("\n")[0] };
        } finally {
          await page.context().close().catch(() => {});
        }
      }
      return { route, ...res };
    });
  } finally {
    await browser.close();
  }
}

function snapshotSide(snapDir, route, slug) {
  const c = config();
  const file = path.join(snapDir, "html", `${slug || slugOf(route)}.html`);
  if (!fs.existsSync(file)) return null;
  const skip = [...NOISE_SELECTORS, ...dynamicSelectors(route), ...listArg("ignore-selectors")];
  return extractHtml(fs.readFileSync(file, "utf8"), { root: c.rootSelector, skip });
}

const resolveSnap = (p) => (fs.existsSync(path.join(p, "manifest.json")) ? p : path.join(process.cwd(), config().snapshotsDir, p));

export async function run() {
  const c = config();
  const max = Number(arg("max", 3));
  const from = arg("from"), to = arg("to"), only = arg("only");
  let mode, results = [], name;

  if (from && to) {
    mode = "snapshot";
    const A = resolveSnap(String(from)), B = resolveSnap(String(to));
    const ea = manifestEntries(A), eb = manifestEntries(B);
    const byRoute = (es) => new Map(es.map((e) => [e.route, e]));
    const ma = byRoute(ea), mb = byRoute(eb);
    const explicit = listArg("routes");
    const routes = explicit.length ? explicit : [...new Set([...ma.keys(), ...mb.keys()])];
    name = arg("out", `snap-${path.basename(A)}-vs-${path.basename(B)}`);
    for (const route of routes) {
      const ra = ma.get(route), rb = mb.get(route);
      const sa = ra && (!ra.status || ra.status < 400) ? snapshotSide(A, route, ra.slug) : null;
      const sb = rb && (!rb.status || rb.status < 400) ? snapshotSide(B, route, rb.slug) : null;
      const entry = { route, statusA: ra?.status ?? null, statusB: rb?.status ?? null };
      if (!sa && !sb) continue; // not a page on either side (404 probe, redirects)
      if (!sa || !sb) { entry.routeChange = sb ? "added" : "removed"; results.push(entry); continue; }
      const lang = langFor(route, sb.lang);
      results.push({ ...entry, lang, ...diffStrings(sa, sb), flags: flagsOf(sb, { lang, other: sa, offline: true }) });
    }
  } else if (only) {
    mode = "audit";
    const routes = pickRoutes();
    name = arg("out", `audit-${String(only).replace(/[^\w.-]+/g, "_")}`);
    if (only === "live" || only === "local") {
      for (const r of await renderedSides(routes, [only])) {
        const s = r[only];
        if (s.error) { results.push({ route: r.route, error: s.error }); continue; }
        const lang = langFor(r.route, s.lang);
        results.push({ route: r.route, status: s.status, lang, added: [], removed: [], changed: [], flags: flagsOf(s, { lang }) });
      }
    } else {
      const snap = resolveSnap(String(only));
      const entries = new Map(manifestEntries(snap).map((e) => [e.route, e]));
      const list = listArg("routes").length ? listArg("routes") : [...entries.values()].filter((e) => !e.status || e.status < 400).map((e) => e.route);
      for (const route of list) {
        const s = snapshotSide(snap, route, entries.get(route)?.slug);
        if (!s) { results.push({ route, error: "not in snapshot" }); continue; }
        const lang = langFor(route, s.lang);
        results.push({ route, lang, added: [], removed: [], changed: [], flags: flagsOf(s, { lang, offline: true }) });
      }
    }
  } else {
    mode = "live-local";
    const routes = pickRoutes();
    name = arg("out", "live-vs-local");
    for (const r of await renderedSides(routes, ["live", "local"])) {
      if (r.live.error || r.local.error) { results.push({ route: r.route, error: r.live.error || r.local.error, statusLive: r.live.status, statusLocal: r.local.status }); continue; }
      const lang = langFor(r.route, r.local.lang || r.live.lang);
      const extra = r.live.lang !== r.local.lang ? [{ cat: "head", from: `html lang: ${r.live.lang}`, to: `html lang: ${r.local.lang}`, kind: "text" }] : [];
      const d = diffStrings(r.live, r.local);
      results.push({ route: r.route, statusLive: r.live.status, statusLocal: r.local.status, lang, ...d, changed: [...extra, ...d.changed], flags: flagsOf(r.local, { lang, other: r.live }) });
    }
  }

  const file = outPath("texts", `${name}.json`);
  const rel = writeJson(file, { mode, at: new Date().toISOString(), live: c.live, local: c.local, from: from || null, to: to || null, only: only || null, routes: results });
  printSummary(mode, results, max, rel, { from, to, only });
  return { mode, results, file };
}

function printSummary(mode, results, max, rel, { from, to, only }) {
  const label = mode === "snapshot" ? `${path.basename(String(from))} × ${path.basename(String(to))}` : mode === "audit" ? `audit of ${only}` : "live × local";
  const withDiff = results.filter((r) => r.added?.length || r.removed?.length || r.changed?.length || r.routeChange);
  const newFlags = results.flatMap((r) => (r.flags || []).filter((f) => !f.inherited));
  const inh = results.flatMap((r) => (r.flags || []).filter((f) => f.inherited)).length;
  const errs = results.filter((r) => r.error);
  console.log(`texts: ${label}, ${results.length} routes, ${withDiff.length} with differences, ${newFlags.length} flags${inh ? ` (+${inh} inherited)` : ""}${errs.length ? `, ${errs.length} errors` : ""}`);
  let lines = 0;
  for (const r of results) {
    if (lines > 60) { console.log("  …"); break; }
    if (r.error) { console.log(`  ${r.route}: error ${showText(r.error, 90)}`); lines++; continue; }
    if (r.routeChange) { console.log(`  ${r.route}: route ${r.routeChange} (${r.statusA ?? "-"} → ${r.statusB ?? "-"})`); lines++; continue; }
    const fl = (r.flags || []).filter((f) => !f.inherited);
    if (!(r.added.length || r.removed.length || r.changed.length || fl.length)) continue;
    console.log(`  ${r.route}  +${r.added.length} −${r.removed.length} ~${r.changed.length}${fl.length ? `  flags ${fl.length}` : ""}`);
    lines++;
    for (const x of r.changed.slice(0, max)) { console.log(`    ~ ${x.cat} "${showText(x.from, 40)}" → "${showText(x.to, 40)}"${x.kind !== "text" ? ` (${x.kind})` : ""}`); lines++; }
    for (const x of r.removed.slice(0, max)) { console.log(`    − ${x.cat} "${showText(x.text, 80)}"`); lines++; }
    for (const x of r.added.slice(0, max)) { console.log(`    + ${x.cat} "${showText(x.text, 80)}"`); lines++; }
    for (const f of fl.slice(0, max)) { console.log(`    ! ${f.flag}${f.detail ? ` (${showText(f.detail, 30)})` : ""}: ${f.cat} "${showText(f.text, 60)}"`); lines++; }
  }
  console.log(`JSON: ${rel}`);
}

if (isMain(import.meta.url)) {
  run().catch((e) => { console.error("texts:", e.message); process.exit(1); });
}
