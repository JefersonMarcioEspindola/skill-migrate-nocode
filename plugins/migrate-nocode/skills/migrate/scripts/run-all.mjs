// Runs measure (and optionally sections) for every route x width and prints a SHORT summary.
// Routes: --routes, else the latest snapshot manifest (status 200 + the 404 probe), else config.routes, else "/".
// Usage: node tools/migrate/run-all.mjs [--routes /,/about] [--widths 1920,1440,768,390] [--concurrency 2] [--sections]
//        [--out DIR] [--max 60]
// Output dir (per run, so parallel runs never overwrite each other's summary):
//   --out DIR, else $MIGRATE_OUT as-is, else <outDir>/runs/<timestamp>/ (path also written to <outDir>/latest-run.txt).
// Writes <run>/<slug>/<width>/{live,local,diff}.png, report.json [, sections.json], <run>/summary.json, <run>/summary.md
import fs from "node:fs";
import path from "node:path";
import { config, ROOT, OUT_DIR, slugOf, ensureDir, launch, arg, listArg, readManifest, pct } from "./lib/common.mjs";
import { pool, isMain } from "./lib/compare.mjs";
import { measure } from "./measure.mjs";
import { reviewSections, bad as badSections } from "./sections.mjs";

/** Routes to measure: manifest entries with status 200 plus the 404 probe. */
export function defaultRoutes() {
  const c = config();
  try {
    const m = readManifest();
    const list = (m.routes || m.pages || []).map((r) => (typeof r === "string" ? { route: r, status: 200 } : { route: r.route || r.path, status: r.status ?? 200 }));
    const ok = list.filter((r) => r.status === 200).map((r) => r.route);
    const nf = list.filter((r) => r.status === 404).map((r) => r.route);
    if (ok.length) return [...new Set([...ok, ...(nf.length ? nf : [c.notFoundProbe].filter(Boolean))])];
  } catch {}
  return c.routes?.length ? c.routes.map((r) => (typeof r === "string" ? r : r.route)) : ["/"];
}

export function runDir() {
  if (typeof arg("out") === "string") return path.resolve(ROOT, arg("out"));
  if (process.env.MIGRATE_OUT) return OUT_DIR();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + process.pid;
  return path.join(OUT_DIR(), "runs", stamp);
}

if (isMain(import.meta.url)) {
  const c = config();
  const routes = listArg("routes", defaultRoutes());
  const widths = listArg("widths", c.widths.map(String)).map(Number);
  const conc = Number(arg("concurrency", 2));
  const withSections = !!arg("sections");
  const dir = ensureDir(runDir());
  if (!arg("out") && !process.env.MIGRATE_OUT) fs.writeFileSync(path.join(OUT_DIR(), "latest-run.txt"), path.relative(ROOT, dir) + "\n");
  const jobs = routes.flatMap((route) => widths.map((width) => ({ route, width })));
  const browser = await launch();
  const t0 = Date.now();
  const rows = await pool(jobs, conc, async ({ route, width }) => {
    const outDir = ensureDir(path.join(dir, slugOf(route), String(width)));
    try {
      const r = await measure({ route, width, outDir, browser });
      const row = { route, width, ok: r.ok, hLive: r.live.height, hLocal: r.local.height, px: r.pixels.ratio, pxMasked: r.pixels.ratioMasked, masks: r.pixels.masks,
        divergences: r.divergences, onlyLive: r.counts.onlyLive, onlyLocal: r.counts.onlyLocal, hscroll: !r.checks.hscroll, report: path.relative(dir, path.join(outDir, "report.json")) };
      if (withSections) {
        const s = await reviewSections({ route, width, browser, outDir });
        row.sections = { ok: s.ok, count: s.sections.length, bad: badSections(s).length, onlyLive: s.onlyLive.length, onlyLocal: s.onlyLocal.length };
        row.ok = row.ok && s.ok;
      }
      return row;
    } catch (e) { return { route, width, ok: false, error: e.message.split("\n")[0] }; }
  });
  await browser.close();
  rows.sort((a, b) => a.route.localeCompare(b.route) || b.width - a.width);
  const summary = { at: new Date().toISOString(), live: c.live, local: c.local, seconds: Math.round((Date.now() - t0) / 1000), total: rows.length, ok: rows.filter((r) => r.ok).length, rows };
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 1));
  const md = [`# Measure run ${summary.at}`, "", `live ${c.live} · local ${c.local} · ok ${summary.ok}/${summary.total}`, "",
    `| route | width | height live | height local | px % | px % masked | divergences | only-live | only-local | h-scroll |${withSections ? " sections |" : ""} ok |`,
    `|---|---|---|---|---|---|---|---|---|---|${withSections ? "---|" : ""}---|`,
    ...rows.map((r) => r.error ? `| ${r.route} | ${r.width} | error: ${r.error} | | | | | | | |${withSections ? " |" : ""} no |`
      : `| ${r.route} | ${r.width} | ${r.hLive} | ${r.hLocal} | ${pct(r.px)} | ${r.masks ? pct(r.pxMasked) : "-"} | ${r.divergences} | ${r.onlyLive} | ${r.onlyLocal} | ${r.hscroll ? "YES" : "no"} |${withSections ? ` ${r.sections.ok ? "ok" : `${r.sections.bad} bad`} |` : ""} ${r.ok ? "yes" : "no"} |`)];
  fs.writeFileSync(path.join(dir, "summary.md"), md.join("\n") + "\n");
  console.log(`run-all: ${rows.length} measurements, ok ${summary.ok}, pending ${rows.length - summary.ok} (${summary.seconds}s)  ->  ${path.relative(process.cwd(), dir)}/summary.md`);
  for (const r of rows.filter((x) => !x.ok).slice(0, Number(arg("max", 60))))
    console.log(r.error ? `  ${r.route} @${r.width} ERROR ${r.error}` : `  ${r.route} @${r.width} h ${r.hLive}/${r.hLocal} px ${pct(r.px)}${r.masks ? ` (masked ${pct(r.pxMasked)})` : ""} div ${r.divergences}${r.hscroll ? " H-SCROLL" : ""}${r.sections && !r.sections.ok ? ` sections-bad ${r.sections.bad}` : ""}`);
}
