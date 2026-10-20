// Builds the /review page: every page in sequence, one row per page, four columns
// (Desktop current | Desktop new | Mobile current | Mobile new), anchors at the top, zoom, and under each capture the
// document height, % of differing pixels and number of divergences (from measure.mjs).
//
// Usage (from the project root; the skill copies this file to tools/migrate/review/):
//   node tools/migrate/review/build-review.mjs [--measure] [--open] [--static review.html] [--widths 1440,390]
//     [--routes /,/about] [--lang en|pt|es] [--template <file>] [--max-height 48000]
//   --measure  re-measure every page × width first (measure.mjs; needs the local production server running)
//   --static   standalone HTML file with relative image paths (no Next.js), assets in <dir>/review-assets/
//   --open     opens the result (macOS open, Linux xdg-open, Windows start)
// Inputs: <outDir>/<slug>/<width>/{live.png,local.png,report.json}. Missing captures are measured automatically
// unless --no-measure. Pages: review.config.json, else migrate.config.json "review", else main pages + one example
// per template (+ the brand 404). Entry: { route, label?, note?, liveRoute? (null = no live page), compare? (false = no %) }.
// Next.js output: <public>/review-assets/<slug>/<width>/{live,local}.webp and app/review/review-html.ts (served by
// app/review/route.ts, installed from assets/review-route.ts when missing).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
/** First existing module among candidates (copied layout tools/migrate/review/ or the skill's own layout). */
async function importFirst(cands) {
  for (const c of cands) { const p = path.resolve(here, c); if (fs.existsSync(p)) return import(pathToFileURL(p).href); }
  throw new Error(`not found: ${cands.join(" | ")}`);
}
const findFile = (cands) => cands.map((c) => path.resolve(here, c)).find((p) => fs.existsSync(p));

const { ROOT, config, OUT_DIR, slugOf, ensureDir, launch, arg, listArg, numListArg, readManifest, latestSnapshot } =
  await importFirst(["../lib/common.mjs", "../../migrate/scripts/lib/common.mjs"]);

// ---------- strings ----------

const I18N = {
  en: { title: "Review — current site × new", heading: "Review · current × new", current: "current site", new: "new", desktop: "Desktop", mobile: "Mobile", both: "Both",
    view: "Columns", zoom: "Zoom", pages: "Pages", generated: "Generated", live: "Live", local: "New", pagesOk: "pages matching", divergences: "divergences",
    avgD: "avg. pixels · desktop", avgM: "avg. pixels · mobile", noLive: "No live counterpart", notMeasured: "Not measured yet (run build-review --measure)",
    newPage: "new page · no pixel comparison", px: "pixels", div1: "divergence", divN: "divergences", ok: "matches", check: "to check", noCompare: "no comparison",
    probe: "(non-existent URL)", open: "open full size", liveAt: "live at", truncated: "truncated" },
  pt: { title: "Revisão — site atual × desenvolvido", heading: "Revisão · atual × desenvolvido", current: "site atual", new: "desenvolvido", desktop: "Desktop", mobile: "Mobile", both: "Ambos",
    view: "Colunas", zoom: "Zoom", pages: "Páginas", generated: "Gerado em", live: "No ar", local: "Novo", pagesOk: "páginas iguais", divergences: "divergências",
    avgD: "média de pixels · desktop", avgM: "média de pixels · mobile", noLive: "Sem página correspondente no site atual", notMeasured: "Ainda não medido (rode build-review --measure)",
    newPage: "página nova · sem comparação de pixels", px: "de pixels", div1: "divergência", divN: "divergências", ok: "igual", check: "conferir", noCompare: "sem comparação",
    probe: "(URL inexistente)", open: "abrir em tamanho real", liveAt: "no ar em", truncated: "cortada" },
  es: { title: "Revisión — sitio actual × nuevo", heading: "Revisión · actual × nuevo", current: "sitio actual", new: "nuevo", desktop: "Desktop", mobile: "Móvil", both: "Ambos",
    view: "Columnas", zoom: "Zoom", pages: "Páginas", generated: "Generado", live: "En vivo", local: "Nuevo", pagesOk: "páginas iguales", divergences: "divergencias",
    avgD: "promedio de píxeles · desktop", avgM: "promedio de píxeles · móvil", noLive: "Sin página equivalente en el sitio actual", notMeasured: "Aún sin medir (ejecute build-review --measure)",
    newPage: "página nueva · sin comparación de píxeles", px: "de píxeles", div1: "divergencia", divN: "divergencias", ok: "igual", check: "revisar", noCompare: "sin comparación",
    probe: "(URL inexistente)", open: "abrir en tamaño real", liveAt: "en vivo en", truncated: "recortada" },
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const anchor = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";

// ---------- pages ----------

function titleCase(s) { return s.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase()); }

function localeCodes(c) { return (c.locales || []).map((l) => (typeof l === "string" ? l : l?.code || l?.prefix || "")).filter(Boolean); }

/** Default: main pages of the default locale + one example per template + the home of every other locale + brand 404. */
function defaultPages(c, entries) {
  const codes = localeCodes(c);
  const defLocale = (c.defaultLocale || codes[0] || "").toLowerCase();
  const split = (route) => {
    const segs = route.split("/").filter(Boolean);
    const loc = segs[0] && codes.some((l) => l.toLowerCase() === segs[0].toLowerCase()) && segs[0].toLowerCase() !== defLocale ? segs.shift() : null;
    return { loc, segs };
  };
  const pages = [], templates = new Map();
  for (const e of entries) {
    const { loc, segs } = split(e.route);
    if (loc) { if (!segs.length) pages.push({ route: e.route, label: `Home ${loc.toUpperCase()}` }); continue; }
    const group = e.template || e.collection || (segs.length >= 2 ? "/" + segs.slice(0, -1).join("/") + "/*" : null);
    if (group) {
      if (!templates.has(group)) templates.set(group, []);
      templates.get(group).push(e);
    } else pages.push({ route: e.route, label: e.label || (segs.length ? titleCase(segs.at(-1)) : "Home") });
  }
  for (const [group, list] of templates) {
    if (list.length === 1 && !list[0].template && !list[0].collection) { const segs = split(list[0].route).segs; pages.push({ route: list[0].route, label: titleCase(segs.join(" · ")) }); continue; }
    const ex = list[0];
    pages.push({ route: ex.route, label: `${titleCase(String(group).replace(/[/*]+/g, " ").trim() || "Template")} (${list.length})`, note: undefined, template: group });
  }
  // Keep manifest order (home first).
  const order = new Map(entries.map((e, i) => [e.route, i]));
  pages.sort((a, b) => (a.route === "/" ? -1 : b.route === "/" ? 1 : (order.get(a.route) ?? 1e9) - (order.get(b.route) ?? 1e9)));
  pages.push({ route: c.notFoundProbe, label: "404", compare: false, probe: true });
  return pages;
}

function loadPages(c) {
  const file = path.join(ROOT, "review.config.json");
  let list = null;
  if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, "utf8")); list = Array.isArray(j) ? j : j.pages; }
  else if (Array.isArray(c.review) && c.review.length) list = c.review;
  let entries = [];
  try { entries = (readManifest(latestSnapshot()).routes || []).map((r) => (typeof r === "string" ? { route: r } : r)); } catch {}
  const status = new Map(entries.map((e) => [e.route, e.status]));
  const live = entries.filter((e) => (!e.status || e.status < 400) && e.route !== c.notFoundProbe);
  if (!list) list = defaultPages(c, live.length ? live : [{ route: "/" }]);
  const only = listArg("routes");
  if (only.length) list = list.filter((p) => only.includes(p.route));
  const seen = new Set();
  return list.map((p) => {
    const liveRoute = p.liveRoute === undefined ? p.route : p.liveRoute;
    const probe = p.probe || p.route === c.notFoundProbe;
    const compare = p.compare ?? (liveRoute !== null && !probe);
    let id = p.id || anchor(p.label || p.route);
    while (seen.has(id)) id += "-2";
    seen.add(id);
    return { ...p, id, label: p.label || p.route, liveRoute, compare, probe, liveStatus: liveRoute ? status.get(liveRoute) : undefined };
  }).filter((p) => {
    // Routes that 404 on live are left out, unless declared as a page without a live counterpart.
    if (p.compare && p.liveStatus >= 400) { console.log(`review: skip ${p.route} (HTTP ${p.liveStatus} on live)`); return false; }
    return true;
  });
}

// ---------- captures ----------

function readReport(dir) {
  const f = path.join(dir, "report.json");
  if (!fs.existsSync(f)) return null;
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const ratio = r.pixels?.ratioMasked ?? r.pixels?.ratio ?? (r.pixels?.pctNoGif ?? r.pixels?.pct) / 100;
  const div = typeof r.divergences === "number" ? r.divergences : Array.isArray(r.divergences) ? r.divergences.length : r.counts?.diffs ?? null;
  return {
    hLive: r.live?.height ?? r.docHeight?.live ?? null, hLocal: r.local?.height ?? r.docHeight?.local ?? null,
    ratio: Number.isFinite(ratio) ? ratio : null, masked: r.pixels?.ratioMasked !== undefined && r.pixels?.ratioMasked !== r.pixels?.ratio,
    divergences: div, ok: typeof r.ok === "boolean" ? r.ok : div === 0 && ratio < 0.003,
  };
}

const TILE = 16000; // WebP max dimension is 16383 px

/** PNG → WebP (split in tiles when taller than 16000 px; capped at maxHeight). Skips work when up to date. */
async function toWebp(png, outBase, maxHeight, produced) {
  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const W = meta.width, H = Math.min(meta.height, maxHeight);
  const n = Math.ceil(H / TILE);
  const mtime = fs.statSync(png).mtimeMs;
  const v = Math.round(mtime).toString(36);
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const top = i * TILE, h = Math.min(TILE, H - top);
    const file = n === 1 ? `${outBase}.webp` : `${outBase}-${i + 1}.webp`;
    produced.add(path.resolve(file));
    if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < mtime) {
      ensureDir(path.dirname(file));
      let img = sharp(png, { limitInputPixels: false });
      if (n > 1 || H < meta.height) img = img.extract({ left: 0, top, width: W, height: h });
      await img.webp({ quality: 72, effort: 4 }).toFile(file);
    }
    tiles.push({ file, w: W, h, v });
  }
  return { tiles, width: W, height: meta.height, truncated: H < meta.height };
}

// ---------- HTML ----------

function buildHtml({ pages, shots, t, lang, widths, c, assetUrl, stamp }) {
  const [dW, mW] = widths;
  const nf = new Intl.NumberFormat(lang === "en" ? "en-US" : lang === "pt" ? "pt-BR" : lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctS = (r) => `${nf.format(r * 100)}%`;
  const status = (p) => {
    if (!p.compare) return "none";
    const s = widths.map((w) => shots[p.id][w]?.report).filter(Boolean);
    if (!s.length) return "none";
    return s.every((r) => r.ok) ? "ok" : "warn";
  };
  const cell = (p, w, side) => {
    const kind = w === dW ? "d" : "m";
    const s = shots[p.id][w];
    const who = `${p.label} — ${kind === "d" ? t.desktop : t.mobile} · ${side === "live" ? t.current : t.new}`;
    const img = s?.[side];
    if (side === "live" && p.liveRoute === null) return `<figure class="cell ${kind}"><div class="frame empty">${esc(t.noLive)}</div><figcaption class="cap">&nbsp;</figcaption></figure>`;
    if (!img) return `<figure class="cell ${kind}"><div class="frame empty">${esc(side === "live" && !p.compare ? t.noLive : t.notMeasured)}</div><figcaption class="cap">&nbsp;</figcaption></figure>`;
    const tiles = img.tiles.map((x, i) => {
      const src = `${assetUrl(x.file)}?v=${x.v}`;
      return `<a href="${esc(src)}" target="_blank" rel="noopener" title="${esc(t.open)}"><img loading="lazy" decoding="async" src="${esc(src)}" width="${x.w}" height="${x.h}" alt="${esc(who)}${img.tiles.length > 1 ? ` (${i + 1}/${img.tiles.length})` : ""}"></a>`;
    }).join("");
    const r = s.report;
    const h = side === "live" ? r?.hLive ?? img.height : r?.hLocal ?? img.height;
    let cap = `${w} × ${h} px${img.truncated ? ` · ${t.truncated}` : ""}`;
    if (side === "local") {
      if (!p.compare) cap += ` · ${esc(t.newPage)}`;
      else if (r) {
        const dh = r.hLive != null && r.hLocal != null ? r.hLocal - r.hLive : 0;
        if (dh) cap += ` · Δh ${dh > 0 ? "+" : ""}${dh}`;
        const parts = [];
        if (r.ratio != null) parts.push(`${pctS(r.ratio)} ${t.px}`);
        if (r.divergences != null) parts.push(`${r.divergences} ${r.divergences === 1 ? t.div1 : t.divN}`);
        if (parts.length) cap += ` · <b class="${r.ok ? "" : "warn"}">${parts.join(" · ")}</b>`;
      }
    }
    return `<figure class="cell ${kind}"><div class="frame">${tiles}</div><figcaption class="cap">${cap}</figcaption></figure>`;
  };
  const badge = (p) => {
    const st = status(p);
    if (st === "none") return p.compare ? "" : `<span class="badge none">${esc(t.noCompare)}</span>`;
    const div = widths.reduce((a, w) => a + (shots[p.id][w]?.report?.divergences || 0), 0);
    return `<span class="badge ${st}">${st === "ok" ? esc(t.ok) : div ? `${div} ${div === 1 ? t.div1 : t.divN}` : esc(t.check)}</span>`;
  };
  const routeLabel = (p) => (p.probe ? t.probe : p.route) + (p.liveRoute && p.liveRoute !== p.route ? ` · ${t.liveAt} ${p.liveRoute}` : "");
  const rows = pages.map((p) => `<div class="row-title" id="${esc(p.id)}"><h2>${esc(p.label)}</h2><code>${esc(routeLabel(p))}</code>${badge(p)}${p.note ? `<p>${esc(p.note)}</p>` : ""}</div>
${cell(p, dW, "live")}${cell(p, dW, "local")}${cell(p, mW, "live")}${cell(p, mW, "local")}`).join("\n");
  const nav = pages.map((p) => `<a href="#${esc(p.id)}"><i class="dot ${status(p)}"></i>${esc(p.label)}</a>`).join("");
  const heads = [[dW, "live"], [dW, "new"], [mW, "live"], [mW, "new"]].map(([w, side]) => `<div class="head ${w === dW ? "d" : "m"}"><i class="dot ${side}"></i>${w === dW ? t.desktop : t.mobile} · ${side === "live" ? t.current : t.new} <span class="cap">${w}px</span></div>`).join("");
  // Totals over pages with a comparison.
  const cmp = pages.filter((p) => p.compare);
  const reps = (w) => cmp.map((p) => shots[p.id][w]?.report).filter((r) => r && r.ratio != null);
  const avg = (w) => { const r = reps(w); return r.length ? r.reduce((a, x) => a + x.ratio, 0) / r.length : null; };
  const okPages = cmp.filter((p) => status(p) === "ok").length;
  const totalDiv = cmp.reduce((a, p) => a + widths.reduce((b, w) => b + (shots[p.id][w]?.report?.divergences || 0), 0), 0);
  const date = new Date().toLocaleString(lang === "en" ? "en-GB" : lang === "pt" ? "pt-BR" : lang, { dateStyle: "medium", timeStyle: "short" });
  const stat = (v, label, cls = "") => `<div class="stat ${cls}"><b>${v}</b>${esc(label)}</div>`;
  const summary = `<section class="summary"><div class="when">${esc(t.generated)} ${esc(date)} · ${esc(t.live)} <a href="${esc(c.live)}" target="_blank" rel="noopener">${esc(c.live.replace(/^https?:\/\//, ""))}</a></div>
<div class="stats">${stat(pages.length, t.pages)}${stat(`${okPages}/${cmp.length}`, t.pagesOk, okPages === cmp.length ? "ok" : "warn")}${stat(totalDiv, t.divergences, totalDiv ? "warn" : "ok")}${avg(dW) != null ? stat(pctS(avg(dW)), t.avgD) : ""}${avg(mW) != null ? stat(pctS(avg(mW)), t.avgM) : ""}</div></section>`;
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  const vals = {
    LANG: lang === "pt" ? "pt-BR" : lang, TITLE: esc(t.title), HEADING: esc(t.heading), STAMP: stamp, NAV: nav, SUMMARY: summary, HEADS: heads, ROWS: rows, DW: dW, MW: mW,
    T_DESKTOP: esc(t.desktop), T_MOBILE: esc(t.mobile), T_BOTH: esc(t.both), T_VIEW: esc(t.view), T_ZOOM: esc(t.zoom), T_PAGES: esc(t.pages),
  };
  const html = tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vals ? String(vals[k]) : m));
  const left = html.match(/\{\{[A-Z_]+\}\}/g);
  if (left) console.log(`review: unknown template tokens ${[...new Set(left)].join(" ")}`);
  return { html, totals: { pages: pages.length, compared: cmp.length, ok: okPages, divergences: totalDiv, avgDesktop: avg(dW), avgMobile: avg(mW) } };
}

// ---------- main ----------

const TEMPLATE = arg("template") && arg("template") !== true ? path.resolve(String(arg("template")))
  : findFile(["./review-template.html", "../assets/review-template.html"]) || path.join(ROOT, "tools/migrate/review/review-template.html");

function openTarget(target) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch (e) { console.log(`review: could not open (${e.message})`); }
}

async function serverHasBuild(url, stamp) {
  try {
    const ctl = AbortSignal.timeout(4000);
    const res = await fetch(url, { signal: ctl, headers: { accept: "text/html" } });
    if (res.status === 401) return "auth";
    return res.ok && (await res.text()).includes(stamp) ? "fresh" : res.ok ? "stale" : "down";
  } catch { return "down"; }
}

async function main() {
  const c = config();
  if (!fs.existsSync(TEMPLATE)) throw new Error(`template not found (${TEMPLATE}). Copy <migrate-review skill>/assets/review-template.html to tools/migrate/review/ or pass --template.`);
  const lang = String(arg("lang", c.reviewLang || "en")).slice(0, 2).toLowerCase();
  const t = I18N[lang] || I18N.en;
  const cw = c.widths || [1440, 390];
  const widths = numListArg("widths", [cw.includes(1440) ? 1440 : Math.max(...cw), cw.includes(390) ? 390 : Math.min(...cw)]).slice(0, 2);
  const pages = loadPages(c);
  const staticFile = arg("static") && arg("static") !== true ? path.resolve(String(arg("static"))) : null;
  const assetsDir = staticFile ? path.join(path.dirname(staticFile), "review-assets") : path.join(ROOT, c.publicDir || "public", "review-assets");
  const maxHeight = Number(arg("max-height", 48000));
  ensureDir(assetsDir);

  // Measure (all with --measure, otherwise only what is missing).
  const outDir = OUT_DIR();
  const dirOf = (p, w) => path.join(outDir, slugOf(p.route), String(w));
  const todo = [];
  for (const p of pages) for (const w of widths) {
    const d = dirOf(p, w);
    if (arg("measure") || (!arg("no-measure") && !fs.existsSync(path.join(d, "local.png")))) todo.push({ p, w, d });
  }
  if (todo.length) {
    const { measure } = await importFirst(["../measure.mjs", "../../migrate/scripts/measure.mjs"]);
    const browser = await launch();
    let i = 0;
    try {
      for (const { p, w, d } of todo) {
        i++;
        try {
          await measure({ route: p.route, width: w, outDir: d, browser, liveRoute: p.liveRoute ?? p.route, localRoute: p.route });
          process.stdout.write(`\rreview: measured ${i}/${todo.length}`);
        } catch (e) { console.log(`\nreview: measure ${p.route} @${w} failed: ${String(e.message || e).split("\n")[0]}`); }
      }
    } finally { await browser.close(); }
    process.stdout.write("\n");
  }

  // Convert captures.
  const produced = new Set();
  const shots = {};
  let missing = 0;
  for (const p of pages) {
    shots[p.id] = {};
    for (const w of widths) {
      const d = dirOf(p, w);
      const s = { report: p.compare ? readReport(d) : null };
      if (!p.compare && fs.existsSync(path.join(d, "report.json"))) { const r = readReport(d); s.report = r ? { hLive: r.hLive, hLocal: r.hLocal } : null; }
      for (const side of ["live", "local"]) {
        const png = path.join(d, `${side}.png`);
        if (side === "live" && p.liveRoute === null) continue;
        if (!fs.existsSync(png)) { missing++; continue; }
        s[side] = await toWebp(png, path.join(assetsDir, slugOf(p.route), String(w), side), maxHeight, produced);
      }
      shots[p.id][w] = s;
    }
  }
  // Remove stale assets from earlier builds.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(assetsDir)) if (!produced.has(path.resolve(f)) && f.endsWith(".webp")) fs.rmSync(f);

  const stamp = crypto.randomBytes(6).toString("hex");
  const build = (assetUrl) => buildHtml({ pages, shots, t, lang, widths, c, assetUrl, stamp });
  let target, out;
  if (staticFile) {
    out = build((file) => path.relative(path.dirname(staticFile), file).split(path.sep).join("/"));
    fs.writeFileSync(staticFile, out.html);
    target = staticFile;
  } else {
    const publicDir = path.join(ROOT, c.publicDir || "public");
    out = build((file) => "/" + path.relative(publicDir, file).split(path.sep).join("/"));
    const appDir = fs.existsSync(path.join(ROOT, "app")) || !fs.existsSync(path.join(ROOT, "src/app")) ? path.join(ROOT, "app") : path.join(ROOT, "src/app");
    const reviewDir = ensureDir(path.join(appDir, "review"));
    fs.writeFileSync(path.join(reviewDir, "review-html.ts"), `// Generated by tools/migrate/review/build-review.mjs. Do not edit.\nexport const REVIEW_HTML = ${JSON.stringify(out.html)};\n`);
    const routeFile = path.join(reviewDir, "route.ts");
    if (!fs.existsSync(routeFile)) {
      const src = findFile(["./review-route.ts", "../assets/review-route.ts"]);
      if (src) { fs.copyFileSync(src, routeFile); console.log(`review: installed ${path.relative(ROOT, routeFile)}`); }
      else console.log(`review: copy <migrate-review skill>/assets/review-route.ts to ${path.relative(ROOT, routeFile)}`);
    }
    target = `${c.local}/review`;
    // Fallback file so the page can always be opened, even when the server is not running the new build.
    const fallback = path.join(OUT_DIR(), "review.html");
    ensureDir(path.dirname(fallback));
    fs.writeFileSync(fallback, build((file) => path.relative(path.dirname(fallback), file).split(path.sep).join("/")).html);
    if (arg("open")) {
      const st = await serverHasBuild(target, stamp);
      if (st !== "fresh" && st !== "auth") {
        console.log(`review: ${target} ${st === "stale" ? "serves an older build (rebuild/restart the production server)" : "is not reachable"}; opening ${path.relative(ROOT, fallback)}`);
        target = fallback;
      }
    }
  }
  const T = out.totals;
  const pctS = (r) => (r == null ? "-" : (r * 100).toFixed(2) + "%");
  console.log(`review: ${T.pages} pages (${T.ok}/${T.compared} matching, ${T.divergences} divergences, avg px ${pctS(T.avgDesktop)} desktop / ${pctS(T.avgMobile)} mobile)${missing ? `, ${missing} captures missing` : ""}`);
  console.log(`review: ${target.startsWith("http") ? target : pathToFileURL(target).href}`);
  if (arg("open")) openTarget(target);
}

main().catch((e) => { console.error("review:", e.message); process.exit(1); });
