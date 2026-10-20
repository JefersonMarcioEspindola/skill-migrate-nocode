// Step 2: mirror every asset referenced by the latest snapshot into public/<mirrorPath(url)> and write rewritten
// copies of the platform CSS (url() -> mirror paths) so the project can import it verbatim.
// Sources: facts.assets (img/srcset/video/poster/bg/head/lazy/network/scan), @font-face src and url() of every
// stylesheet (recursively through @import) and inline <style>. Only same-site and config.assetHosts hosts are
// mirrored; other hosts are counted in the summary (add them to assetHosts if they must be local).
// Usage: node tools/migrate/assets.mjs [--verify] [--concurrency 6] [--max-mb 100] [--dry]
//   --verify  re-checks existing files with HEAD (ETag / Content-Length / Last-Modified; conditional GET when HEAD is
//             refused) and re-downloads changed ones: image optimizers regenerate variants after the snapshot.
// Outputs (in snapshots/<date>/): assets-map.json {url: mirrorPath}, assets-meta.json, assets-failed.json,
//          css-local/<host>/<path>.css (+ css-local/inline/<hash>.css)
import fs from "node:fs";
import path from "node:path";
import { config, latestSnapshot, readManifest, arg, isMirroredHost, mirrorPath, mirrorFile } from "./lib/common.mjs";
import { cssRefs, cssImports, fontFaces, rewriteCssUrls, kindOf, ACCEPT, absUrl, cssFileRel, pool, writeFileSafe, readJson } from "./lib/capture.mjs";

const c = config();
const snap = latestSnapshot();
const manifest = readManifest(snap);
const VERIFY = Boolean(arg("verify"));
const DRY = Boolean(arg("dry"));
const CONC = Math.min(8, Math.max(1, Number(arg("concurrency", 6)) || 6));
const MAX_BYTES = (Number(arg("max-mb", 100)) || 100) * 1e6;
const UA = c.userAgent || manifest.userAgent || "Mozilla/5.0 (compatible; migrate-nocode assets)";
const rel = (f) => path.relative(process.cwd(), f);

const facts = fs.readdirSync(path.join(snap, "facts")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(snap, "facts", f), "utf8")));

// ---------------------------------------------------------------- collect
const urls = new Set();
const netType = new Map();
const sheets = new Map(); // href -> { href, file }
const inline = new Map(); // file -> base url
for (const f of facts) {
  f.assets.forEach((u) => urls.add(u));
  for (const face of f.fonts?.faces || []) for (const s of face.src || []) if (s.url) urls.add(s.url);
  for (const r of f.network?.list || []) netType.set(r.url, r.type);
  for (const s of f.stylesheets || []) if (s.file && !sheets.has(s.href)) sheets.set(s.href, { href: s.href, file: s.file });
  for (const s of f.inlineStyles || []) if (s.file && !inline.has(s.file)) inline.set(s.file, f.finalUrl || c.live + f.route);
}

// Stylesheets: url() and @font-face of each; @import targets missing from the snapshot are fetched here.
const fetchText = async (u) => {
  const r = await fetch(u, { headers: { "user-agent": UA, accept: ACCEPT.style, referer: c.live + "/" } });
  return r.ok ? r.text() : null;
};
const queue = [...sheets.values()];
let importsFetched = 0;
while (queue.length) {
  const s = queue.shift();
  const file = path.join(snap, s.file);
  let css = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (css == null && !DRY) {
    css = await fetchText(s.href).catch(() => null);
    if (css != null) { writeFileSafe(file, css); importsFetched++; }
  }
  if (css == null) continue;
  cssRefs(css, s.href).forEach((u) => urls.add(u));
  for (const f of fontFaces(css, s.href)) for (const x of f.src) if (x.url) urls.add(x.url);
  for (const imp of cssImports(css, s.href)) if (!sheets.has(imp.url)) { const n = { href: imp.url, file: `css/${cssFileRel(imp.url)}` }; sheets.set(imp.url, n); queue.push(n); }
}
for (const [file, base] of inline) { const p = path.join(snap, file); if (fs.existsSync(p)) cssRefs(fs.readFileSync(p, "utf8"), base).forEach((u) => urls.add(u)); }

const hostOf = (u) => new URL(u).host;
const unmirrored = {};
const list = [];
for (const u of urls) {
  const k = kindOf(u);
  if (k === "style" || k === "script" || netType.get(u) === "document") continue;
  if (isMirroredHost(hostOf(u))) list.push(u);
  else unmirrored[hostOf(u)] = (unmirrored[hostOf(u)] || 0) + 1;
}
list.sort();

// ---------------------------------------------------------------- download
const metaFile = path.join(snap, "assets-meta.json");
const meta = readJson(metaFile, {});
const TYPE_TO_KIND = { image: "image", font: "font", media: "media", stylesheet: "style", fetch: "data", xhr: "data" };
const acceptFor = (u) => ACCEPT[TYPE_TO_KIND[netType.get(u)] || (kindOf(u) === "other" ? "image" : kindOf(u))] || ACCEPT.other;
const headersFor = (u, extra = {}) => ({ "user-agent": UA, accept: acceptFor(u), referer: c.live + "/", ...extra });
const pick = (h) => ({ etag: h.get("etag"), lastModified: h.get("last-modified"), contentLength: h.get("content-length"), contentEncoding: h.get("content-encoding"), contentType: h.get("content-type") });

let downloaded = 0, existing = 0, changed = 0, bytes = 0, skippedBig = 0;
const failed = [];

/** True when the remote file differs from what we stored (or we cannot tell and the sizes disagree). */
async function isChanged(u, file) {
  const m = meta[u] || {};
  let r;
  try { r = await fetch(u, { method: "HEAD", headers: headersFor(u) }); } catch { return false; }
  if ([403, 405, 501].includes(r.status)) {
    // HEAD refused: conditional GET (304 = unchanged). Body is drained only when it changed.
    const cond = {};
    if (m.etag) cond["if-none-match"] = m.etag;
    if (m.lastModified) cond["if-modified-since"] = m.lastModified;
    if (!Object.keys(cond).length) return false;
    try { r = await fetch(u, { headers: headersFor(u, cond) }); } catch { return false; }
    if (r.status === 304) return false;
    await r.body?.cancel();
    return r.ok;
  }
  if (!r.ok) return false;
  const h = pick(r.headers);
  if (h.etag && m.etag) return h.etag.replace(/^W\//, "") !== m.etag.replace(/^W\//, "");
  if (h.contentLength && m.contentLength && !h.contentEncoding) return h.contentLength !== m.contentLength;
  if (h.lastModified && m.lastModified) return h.lastModified !== m.lastModified;
  if (h.contentLength && !h.contentEncoding) return Number(h.contentLength) !== fs.statSync(file).size;
  return false;
}

async function download(u, file) {
  const r = await fetch(u, { headers: headersFor(u) });
  if (!r.ok) { await r.body?.cancel(); throw new Error(`HTTP ${r.status}`); }
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BYTES) { await r.body?.cancel(); skippedBig++; throw new Error(`skipped: ${(len / 1e6).toFixed(1)} MB > --max-mb`); }
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSafe(file, buf);
  meta[u] = { path: mirrorPath(u), status: r.status, bytes: buf.length, ...pick(r.headers), fetchedAt: new Date().toISOString() };
  bytes += buf.length;
  downloaded++;
}

if (!DRY) {
  await pool(list, CONC, async (u) => {
    const file = mirrorFile(u);
    try {
      if (fs.existsSync(file)) {
        if (!VERIFY || !(await isChanged(u, file))) { existing++; return; }
        changed++;
      }
      await download(u, file);
    } catch (e) {
      failed.push({ url: u, error: e.code === "ENOTDIR" || e.code === "EISDIR" ? `path conflict (${e.code})` : e.message });
    }
  });
}

const map = {};
for (const u of list) if (DRY || fs.existsSync(mirrorFile(u))) map[u] = mirrorPath(u);
if (!DRY) {
  fs.writeFileSync(path.join(snap, "assets-map.json"), JSON.stringify(map, null, 1));
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(snap, "assets-failed.json"), JSON.stringify({ failed, unmirroredHosts: unmirrored }, null, 1));
}

// ---------------------------------------------------------------- css-local
// Rewritten copies: url() -> mirror path (when mirrored), @import -> relative path of the local copy.
let cssLocal = 0;
const localDir = path.join(snap, "css-local");
const rewriteImports = (css, href, fromRel) => css.replace(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')/gi, (all, a, b, d, e, f) => {
  const u = absUrl(a ?? b ?? d ?? e ?? f, href);
  if (!u || !sheets.has(u)) return all;
  let r = path.relative(path.dirname(fromRel), cssFileRel(u)).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  return `@import url("${r}")`;
});
const mapUrl = (u) => map[u] || null;
if (!DRY) {
  for (const s of sheets.values()) {
    const src = path.join(snap, s.file);
    if (!fs.existsSync(src)) continue;
    const r = cssFileRel(s.href);
    const out = rewriteCssUrls(rewriteImports(fs.readFileSync(src, "utf8"), s.href, r), s.href, mapUrl);
    writeFileSafe(path.join(localDir, r), out);
    cssLocal++;
  }
  for (const [file, base] of inline) {
    const src = path.join(snap, file);
    if (!fs.existsSync(src)) continue;
    const r = path.join("inline", path.basename(file));
    writeFileSafe(path.join(localDir, r), rewriteCssUrls(rewriteImports(fs.readFileSync(src, "utf8"), base, r), base, mapUrl));
    cssLocal++;
  }
}

const top = Object.entries(unmirrored).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => `${h}(${n})`).join(", ");
if (DRY) console.log(`assets (dry): ${list.length} to mirror from ${new Set(list.map(hostOf)).size} host(s); not mirrored: ${top || "none"}`);
else {
  console.log(`assets: ${list.length} urls, downloaded ${downloaded} (${(bytes / 1e6).toFixed(1)} MB), existing ${existing}${VERIFY ? `, changed on live ${changed}` : ""}, failed ${failed.length}${skippedBig ? ` (${skippedBig} over --max-mb)` : ""}${importsFetched ? `, @import css fetched ${importsFetched}` : ""}`);
  console.log(`  css-local: ${cssLocal} file(s) -> ${rel(localDir)}/; map -> ${rel(path.join(snap, "assets-map.json"))}`);
  if (top) console.log(`  not mirrored (add to assetHosts if needed): ${top}`);
  for (const f of failed.slice(0, 5)) console.log(`  fail ${f.error}: ${f.url.slice(0, 140)}`);
}
