// Interaction states (hover / focus / click / step sequence), live vs local, same width.
// Usage: node tools/migrate/states.mjs --route /about --width 390 --target "#menuButton" --action click|hover|focus|none
//        [--steps "click:SEL,wait:600,hover:SEL,scroll:Y,press:KEY,unhover,blur:SEL"] [--samples 80,1000]
//        [--scope SEL] [--label menu] [--no-scroll] [--no-clock] [--full] [--max 30]
// REST is measured with the mouse parked in a corner; then the steps run and STATE is sampled 80 ms and 1000 ms
// after the last step (--samples). Prints what changed REST -> STATE on each site and the live x local divergences.
// Compares transform/opacity/visibility/display/clip-path (and more), hidden elements and boxes by id/idAttribute.
// Output: <outDir>/<slug>/<width>/states-<label>/{live,local}-{rest,state-<ms>}[-full].png, side-by-side.png, diff.png, report.json
import fs from "node:fs";
import path from "node:path";
import { config, OUT_DIR, slugOf, ensureDir, launch, arg, listArg, pct } from "./lib/common.mjs";
import { preparePage, newPage, screenshotDiff, sideBySide, scrollFn, isMain } from "./lib/compare.mjs";
import { extract, pair, diffPairs, fmtProp } from "./measure.mjs";

const STATE_PROPS = ["transform", "opacity", "visibility", "display", "clipPath", "pointerEvents", "zIndex", "height", "width", "top", "left", "right", "bottom", "translate", "scale", "rotate", "outlineStyle", "outlineColor", "textDecorationColor", "cursor"];
const MOTION = new Set(["opacity", "transform", "visibility", "display", "clipPath", "translate", "scale", "rotate"]);
const slugify = (s) => String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40) || "x";

/** "click:#a,wait:600,click:#a" -> [{op,val}], without breaking selectors that contain commas. */
export function parseSteps(s) {
  return s.split(/,(?=\s*(?:click|hover|focus|blur|unhover|wait|scroll|press)\b)/).map((t) => {
    const i = t.indexOf(":");
    return i === -1 ? { op: t.trim(), val: "" } : { op: t.slice(0, i).trim(), val: t.slice(i + 1).trim() };
  });
}

/** Pairs like measure.pair() plus boxes by key (#id / [idAttribute=...]), n-th occurrence. */
function pairAll(a, b) {
  const r = pair(a, b);
  const bucket = new Map();
  for (const e of b.filter((e) => e.kind === "box")) { if (!bucket.has(e.key)) bucket.set(e.key, []); bucket.get(e.key).push(e); }
  for (const e of a.filter((e) => e.kind === "box")) { const q = bucket.get(e.key); if (q?.length) r.pairs.push([e, q.shift()]); else r.onlyLive.push(e); }
  for (const q of bucket.values()) r.onlyLocal.push(...q);
  r.pairs.sort((x, y) => x[0].y - y[0].y || x[0].x - y[0].x);
  return r;
}

const name = (d) => (d.kind === "box" ? d.key : `[${d.kind}] "${String(d.key).slice(0, 40)}"`);
/** Flat list of (element, prop) changes, motion props and boxes first. */
function flat(diffs) {
  const rows = [];
  for (const d of diffs) for (const p of d.props) rows.push({ el: name(d), s: fmtProp(p), score: (MOTION.has(p.prop) ? 0 : 2) + (d.kind === "box" ? 0 : 1) });
  return rows.sort((a, b) => a.score - b.score);
}

export async function runStates({ route, width, steps, samples = [80, 1000], scope = null, clock = true, scroll = true, full = false, browser, outDir }) {
  const c = config();
  const wait = async (page, ms) => { if (clock) await page.clock.runFor(ms); await page.waitForTimeout(ms); }; // JS on the fake clock + CSS on real time
  async function runStep(page, { op, val }) {
    const opts = { timeout: 8000 };
    try {
      if (op === "click") await page.locator(val).first().click(opts);
      else if (op === "hover") await page.locator(val).first().hover(opts);
      else if (op === "focus") await page.locator(val).first().focus(opts);
      else if (op === "blur") await page.locator(val).first().blur(opts);
      else if (op === "unhover") await page.mouse.move(1, 1);
      else if (op === "press") await page.keyboard.press(val);
      else if (op === "scroll") await page.evaluate(scrollFn, Number(val));
      else if (op === "wait") return wait(page, Number(val) || 0);
      else throw new Error(`unknown step "${op}"`);
    } catch (e) {
      // fallback: synthetic event (element covered or "unstable" under the paused clock)
      if (["click", "focus"].includes(op)) {
        const ok = await page.evaluate(([sel, op]) => { const el = document.querySelector(sel); if (!el) return false; op === "click" ? el.click() : el.focus(); return true; }, [val, op]).catch(() => false);
        if (ok) return `${op} ${val}: synthetic fallback (${e.message.split("\n")[0].slice(0, 80)})`;
      }
      return `${op} ${val}: FAILED (${e.message.split("\n")[0].slice(0, 100)})`;
    }
    if (clock) await page.clock.runFor(16); // one frame for handlers scheduled via rAF
  }
  async function site(base, side) {
    const page = await newPage(browser, width);
    try {
      await preparePage(page, base + route, { side, clock, scroll });
      await page.mouse.move(1, 1); // nothing starts hovered
      if (clock) await page.clock.runFor(100);
      await page.waitForTimeout(100);
      const opts = { extraProps: STATE_PROPS, scope, includeHidden: true, boxes: true };
      const rest = await extract(page, opts);
      const shots = { rest: await page.screenshot() };
      if (full) shots["rest-full"] = await page.screenshot({ fullPage: true });
      const notes = [];
      for (const s of steps) { const n = await runStep(page, s); if (n) notes.push(n); }
      const states = [];
      let t = 0;
      for (const ms of samples) {
        await wait(page, Math.max(0, ms - t)); t = ms;
        states.push({ ms, data: await extract(page, opts) });
        shots[`state-${ms}`] = await page.screenshot();
      }
      if (full) shots["state-full"] = await page.screenshot({ fullPage: true });
      return { rest, states, shots, notes };
    } finally { await page.context().close().catch(() => {}); }
  }
  const [L, C] = await Promise.all([site(c.live, "live"), site(c.local, "local")]);
  ensureDir(outDir);
  for (const [k, s] of [["live", L], ["local", C]]) for (const [n, buf] of Object.entries(s.shots)) fs.writeFileSync(path.join(outDir, `${k}-${n}.png`), buf);
  const last = samples.at(-1);
  fs.writeFileSync(path.join(outDir, "side-by-side.png"), sideBySide(L.shots[`state-${last}`], C.shots[`state-${last}`]));
  const px = screenshotDiff(L.shots[`state-${last}`], C.shots[`state-${last}`], path.join(outDir, "diff.png"));
  const restX = pairAll(L.rest.elements, C.rest.elements);
  const restSet = new Set(diffPairs(restX.pairs).flatMap((d) => d.props.map((p) => name(d) + "|" + fmtProp(p))));
  const perSample = samples.map((ms, i) => {
    const ls = L.states[i].data, cs = C.states[i].data;
    const change = (s, st) => { const p = pairAll(s.rest.elements, st.elements); return { diffs: diffPairs(p.pairs), appeared: p.onlyLocal, gone: p.onlyLive }; };
    const x = pairAll(ls.elements, cs.elements);
    const d = diffPairs(x.pairs);
    for (const e of d) e.isNew = e.props.some((p) => !restSet.has(name(e) + "|" + fmtProp(p)));
    d.sort((a, b) => b.isNew - a.isNew);
    return { ms, restToState: { live: change(L, ls), local: change(C, cs) }, stateDiffs: d, onlyLive: x.onlyLive.map(({ style, ...e }) => e), onlyLocal: x.onlyLocal.map(({ style, ...e }) => e) };
  });
  const strip = (c) => ({ diffs: c.diffs, appeared: c.appeared.map(({ style, ...e }) => e), gone: c.gone.map(({ style, ...e }) => e) });
  const report = {
    route, width, steps, samples, scope, clock, at: new Date().toISOString(), pixelsState: { ratio: px.ratio },
    notes: { live: L.notes, local: C.notes }, scopeFound: { live: L.rest.scopeFound, local: C.rest.scopeFound },
    sampled: perSample.map((s) => ({ ...s, restToState: { live: strip(s.restToState.live), local: strip(s.restToState.local) } })),
  };
  const fin = perSample.at(-1);
  report.divergences = fin.stateDiffs.filter((d) => d.isNew).length + fin.onlyLive.length + fin.onlyLocal.length;
  report.ok = report.divergences === 0;
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1));
  return { report, perSample, px };
}

if (isMain(import.meta.url)) {
  const route = arg("route", "/");
  const width = Number(arg("width", 1440));
  const target = typeof arg("target") === "string" ? arg("target") : null;
  const action = arg("action", target ? "click" : "none");
  const stepsArg = typeof arg("steps") === "string" ? arg("steps") : null;
  const extraWait = arg("wait") ? Number(arg("wait")) : 0;
  let steps = stepsArg ? parseSteps(stepsArg) : action === "none" || !target ? [] : [{ op: action, val: target }];
  if (extraWait) steps.push({ op: "wait", val: String(extraWait) });
  const samples = listArg("samples", ["80", "1000"]).map(Number).filter((n) => n >= 0).sort((a, b) => a - b);
  const label = arg("label", null) || slugify(stepsArg ? steps.map((s) => s.op + "-" + s.val).join("_") : `${action}-${target || "none"}`);
  const outDir = path.join(OUT_DIR(), slugOf(route), String(width), `states-${label}`);
  const scope = typeof arg("scope") === "string" ? arg("scope") : null;
  const browser = await launch();
  const { report, perSample, px } = await runStates({ route, width, steps, samples, scope, clock: !arg("no-clock"), scroll: !arg("no-scroll"), full: !!arg("full"), browser, outDir });
  await browser.close();
  const maxPrint = Number(arg("max", 30));
  const out = [`states ${route} @${width}  ${steps.map((s) => s.op + (s.val ? ":" + s.val : "")).join(" > ") || "(no action)"}  scope ${scope || "page"}  clock ${report.clock ? "fake (+real time for CSS)" : "real"}`];
  if (scope && (!report.scopeFound.live || !report.scopeFound.local)) out.push(`  WARNING: scope not found (live ${report.scopeFound.live}, local ${report.scopeFound.local})`);
  for (const k of ["live", "local"]) for (const n of report.notes[k]) out.push(`  ${k}: ${n}`);
  for (const s of perSample) {
    const fin = s === perSample.at(-1);
    out.push(`+${s.ms}ms`);
    for (const [k, c] of [["LIVE", s.restToState.live], ["LOCAL", s.restToState.local]]) {
      out.push(`  ${k} rest→state: ${c.diffs.length} elements changed, ${c.appeared.length} appeared, ${c.gone.length} gone`);
      if (fin) for (const r of flat(c.diffs).slice(0, 15)) out.push(`    ${r.el} ${r.s}`);
    }
    out.push(`  LIVE x LOCAL: ${s.stateDiffs.length} divergent elements (${s.stateDiffs.filter((d) => d.isNew).length} new vs REST), only-live ${s.onlyLive.length}, only-local ${s.onlyLocal.length}`);
    if (fin) for (const d of s.stateDiffs.slice(0, maxPrint)) out.push(`    ${d.isNew ? "*" : " "}${name(d)} y=${d.y}: ${d.props.slice(0, 5).map(fmtProp).join("; ")}`);
  }
  out.push(`  viewport px ${pct(px.ratio)}  (* = divergence not present at REST)  files: ${path.relative(process.cwd(), outDir)}/`);
  console.log(out.join("\n"));
}
