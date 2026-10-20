// Compares the <head> and HTTP behaviour of live vs local per route and prints only the differences: HTTP status,
// redirect chain, html lang, title, description, robots, viewport, canonical, hreflang, icons, JSON-LD types and
// every og:* / twitter:* meta. Metadata is read from the whole document (Next.js may stream it into <body>).
// Usage: node tools/migrate/head-check.mjs [--routes /,/about] [--snapshot] [--same-host] [--concurrency 3] [--max 40]
//   --snapshot   live side from snapshot facts (no live requests)
//   --same-host  treat the local origin as the live origin inside local values (when canonical/og:url are built
//                from the request host in dev)
// Full report: <outDir>/head-check.json
import fs from "node:fs";
import path from "node:path";
import { config, readManifest, latestSnapshot, listArg, arg, OUT_DIR } from "./lib/common.mjs";
import { headFacts, headDigest, pool, readJson } from "./lib/capture.mjs";

const c = config();
const SNAPSHOT = Boolean(arg("snapshot"));
const SAME_HOST = Boolean(arg("same-host"));
const CONC = Math.min(4, Math.max(1, Number(arg("concurrency", 3)) || 3));
const MAX = Number(arg("max", 40)) || 40;
const manifest = readManifest();
const routes = listArg("routes").length ? listArg("routes").map((r) => (r === "404" ? c.notFoundProbe : r)) : manifest.routes.filter((r) => r.status !== "error").map((r) => r.route);
const UA = "Mozilla/5.0 (compatible; migrate-nocode head-check)";
const pathOf = (u, base) => { try { const x = new URL(u, base); return x.pathname + x.search; } catch { return u; } };

async function fetchChain(url) {
  const chain = [];
  let u = url;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(u, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { chain.push(`${r.status} ${pathOf(loc, u)}`); await r.body?.cancel(); u = new URL(loc, u).href; continue; }
    return { status: r.status, chain, html: await r.text() };
  }
  return { status: "too many redirects", chain, html: "" };
}

function digestOf(res) {
  const d = res.html ? headDigest(headFacts(res.html)) : {};
  return { "http status": String(res.status), redirects: res.chain.join(" -> ") || null, ...d };
}

const snapDir = latestSnapshot();
async function liveSide(route) {
  if (!SNAPSHOT) return fetchChain(c.live + route);
  const slug = route === c.notFoundProbe ? "404" : manifest.routes.find((r) => r.route === route)?.slug;
  const f = slug && readJson(path.join(snapDir, "facts", `${slug}.json`));
  if (!f) return { status: "not in snapshot", chain: [], html: "" };
  return { status: f.status, chain: (f.redirects || []).map((r) => `${r.status} ${pathOf(r.location || "", r.url)}`), head: f.head };
}

let unreachable = 0;
const results = await pool(routes, CONC, async (route) => {
  let live, local;
  try { live = await liveSide(route); } catch (e) { live = { status: `error ${e.cause?.code || e.message}`, chain: [], html: "" }; }
  try { local = await fetchChain(c.local + route); } catch (e) { unreachable++; local = { status: `error ${e.cause?.code || e.message}`, chain: [], html: "" }; }
  const A = live.head ? { "http status": String(live.status), redirects: live.chain.join(" -> ") || null, ...headDigest(live.head) } : digestOf(live);
  let B = digestOf(local);
  if (SAME_HOST) {
    const lo = new URL(c.local).origin, li = new URL(c.live).origin;
    B = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, typeof v === "string" ? v.split(lo).join(li) : v]));
  }
  const diffs = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => (A[k] ?? null) !== (B[k] ?? null)).map((k) => ({ key: k, live: A[k] ?? null, local: B[k] ?? null }));
  return { route, diffs };
});

const bad = results.filter((r) => r.diffs.length);
fs.mkdirSync(OUT_DIR(), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR(), "head-check.json"), JSON.stringify({ live: SNAPSHOT ? `snapshot ${path.basename(snapDir)}` : c.live, local: c.local, results }, null, 1));
console.log(`head-check: ${routes.length} route(s), with differences ${bad.length}, total diffs ${bad.reduce((a, r) => a + r.diffs.length, 0)}${SNAPSHOT ? " (live from snapshot)" : ""}`);
if (unreachable === routes.length) console.log(`  local not reachable at ${c.local} (start the dev server or set LOCAL_URL)`);
const cut = (v) => (v == null ? "(none)" : `"${String(v).length > 90 ? String(v).slice(0, 87) + "..." : v}"`);
let shown = 0;
for (const r of bad) {
  if (shown >= MAX) { console.log(`  ... see ${path.relative(process.cwd(), path.join(OUT_DIR(), "head-check.json"))}`); break; }
  console.log(r.route);
  for (const d of r.diffs) { if (shown++ >= MAX) break; console.log(`  ${d.key}: live ${cut(d.live)} | local ${cut(d.local)}`); }
}
