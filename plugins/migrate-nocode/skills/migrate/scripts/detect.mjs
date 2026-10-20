// Guesses the platform of a live site (Ycode, Webflow, Framer, WordPress) and prints the evidence plus a starter
// migrate.config.json. Works before migrate.config.json exists (never calls config()).
// Usage: node tools/migrate/detect.mjs <url> [--render] [--json]
//   --render  also renders the page in Chromium (default: only when the raw HTML is inconclusive)
import { PLATFORM_PRESETS, arg } from "./lib/common.mjs";
import { parseHtml, querySelector, sectionNodes } from "./lib/capture.mjs";
import { detectPlatform } from "./lib/platforms/index.mjs";

const url = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
if (!url) { console.error("usage: node detect.mjs <https://site> [--render] [--json]"); process.exit(1); }

async function getRaw(u) {
  const r = await fetch(u, { redirect: "follow", headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0 (compatible; migrate-nocode-detect)" } });
  const headers = Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v]));
  return { status: r.status, finalUrl: r.url, headers, html: await r.text() };
}

async function getRendered(u) {
  const { launch } = await import("./lib/common.mjs");
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const resp = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return { status: resp?.status() ?? 0, html: await page.content() };
  } finally { await browser.close(); }
}

const raw = await getRaw(url);
let det = detectPlatform(raw.html, raw.finalUrl, raw.headers);
let source = "raw HTML";
if (arg("render") || det.platform === "other") {
  try {
    const r = await getRendered(raw.finalUrl);
    const d2 = detectPlatform(r.html, raw.finalUrl, raw.headers);
    if (d2.score > det.score) { det = d2; source = "rendered DOM"; }
  } catch (e) { source += ` (render failed: ${e.message.split("\n")[0]})`; }
}

const live = new URL(raw.finalUrl).origin;
const preset = PLATFORM_PRESETS[det.platform] || PLATFORM_PRESETS.other;
const doc = parseHtml(raw.html);
let rootSelector = preset.rootSelector;
let root = null;
try { root = querySelector(doc, rootSelector); } catch { /* bad selector */ }
if (!root) { rootSelector = "body"; root = querySelector(doc, "body"); }
const sections = root ? sectionNodes(root) : [];
// Descend through single-child wrappers (Framer: #main > div > page frame) to suggest a useful root.
let hint = null;
if (sections.length === 1) {
  let n = sections[0];
  for (let depth = 1; n && depth <= 5; depth++) {
    const kids = sectionNodes(n);
    if (kids.length > 1) { hint = `single-child wrapper; ${depth} level(s) down there are ${kids.length} children (tojsx --list shows a --root hint)`; break; }
    n = kids[0];
  }
}

const cfg = { platform: det.platform, live, ...(rootSelector !== preset.rootSelector ? { rootSelector } : {}) };
if (arg("json")) {
  console.log(JSON.stringify({ url, finalUrl: raw.finalUrl, status: raw.status, source, ...det, config: cfg }, null, 1));
} else {
  const best = det.results[0];
  console.log(`detect ${url} -> ${det.platform}${det.platform !== "other" ? ` (score ${det.score}, from ${source})` : ` (no platform markers in ${source})`}; HTTP ${raw.status}${raw.finalUrl !== url ? `, final ${raw.finalUrl}` : ""}`);
  const top = det.results.find((r) => r.name === det.platform) || best;
  if (top?.evidence.length) console.log(`  evidence: ${top.evidence.map((e) => e.what).join("; ")}`);
  console.log(`  others: ${det.results.filter((r) => r !== top).map((r) => `${r.name} ${r.score}`).join(", ")}`);
  console.log(`  root ${rootSelector}: ${root ? `${sectionNodes(root).length} sections` : "not found"}${hint ? `; ${hint}` : ""}`);
  console.log(`  migrate.config.json: ${JSON.stringify(cfg)}`);
}
