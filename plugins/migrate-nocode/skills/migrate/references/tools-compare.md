# Comparison tools (live vs local)

Scripts in `tools/migrate/`, run from the project root (where `migrate.config.json` lives). They open the live
site and the local app in headless Chromium at the same width and measure the differences. The goal of a migration
is **zero divergences** and **< 0.3% differing pixels** on every route × width.

| Script | Question it answers |
|---|---|
| `measure.mjs` | Does this route at this width match? (elements, styles, heights, pixels) |
| `sections.mjs` | Which section, which element, which CSS property differs? |
| `crop.mjs` | Show me band y0–y1 side by side. |
| `states.mjs` | Do hover / focus / click / menus behave the same? |
| `motion.mjs` | Do animations run the same over time or over scroll? |
| `run-all.mjs` | Everything, all routes × widths, in one summary. |

Terminal output is short; details go to files under `<outDir>/<slug>/<width>/` (`outDir` from config, env
`MIGRATE_OUT` overrides; slug: `/` → `index`, `/pt-br/about` → `pt-br__about`).

## How a page is brought to rest (all tools)

`lib/compare.mjs#preparePage` makes both sides reproducible:

1. **Fake clock** (Playwright `page.clock`), installed paused before navigation: timers, `requestAnimationFrame`,
   `Date`, `performance.now` advance only when the tool says so, by the same amount on both sides. JS animations
   (GSAP, marquees, Lenis, Webflow IX2, Framer Motion) land on the same frame. "Cannot fast-forward to the past"
   is retried automatically. `--no-clock` turns it off.
2. **Seeded `Math.random`**: sites that open on a random slide or shuffle cards render the same thing on both
   sides (`"seedRandom": false` in config to disable).
3. Scroll the whole page (60% of the viewport per step) to fire scroll/enter animations and lazy loading, waiting
   for images triggered by each step before advancing the clock; then back to the top (Lenis / ScrollSmoother /
   Locomotive are scrolled too).
4. Videos paused at 0 and first frame decoded; `loading=lazy` images made eager; images **really** loaded
   (`naturalWidth > 0`; `img.complete` is also true for failed images) with up to 3 reloads, then `img.decode()`.
5. `document.fonts` ready and every `@font-face` forced to load. Fonts with a mirror file
   (`public/_m/...`, see `mirrorFile`) are served from it when the live font host fails or takes > 8 s.
6. DOM convergence: the clock advances until classes / inline styles / data attributes stop changing.
7. Infinite WAAPI/CSS animations (`document.getAnimations()`) paused at `currentTime = 1000` on both sides;
   finite ones still running are finished.
8. Local side only: `window[staticFlag] = true` (unless `--motion`), so motion you added can switch itself off;
   the Next.js dev indicator is hidden; the caret is hidden on both sides.
9. Full-page capture with `will-change` neutralized (Chromium paints filtered layers wrong beyond the viewport).

Viewport height is 900, DPR 1, CSP bypassed (style injection), `userAgent` / `browserLocale` from config.

## measure.mjs

```
node tools/migrate/measure.mjs --route /about --width 1440 [--live-route /sobre] [--local-route /about]
     [--no-clock] [--motion] [--json] [--max 40]
```

- Extracts every visible text, control and media element (icons < 40 px ignored) with box and computed style:
  font family/size/weight/style, **rendered color** (RGBA through a 1×1 canvas; never the computed string, since
  Lightning CSS rewrites colors to `lab()`/`oklab()`), line-height, letter-spacing, transform, border, radius,
  padding, gap, opacity (own and effective), background, shadow, blend mode.
- Pairs texts by content (n-th occurrence; visible copies with visible copies first), controls by label, media by order.
- **Vertical offset discounting**: `y` is reported only where the jump between live and local *changes*. A section
  60 px taller on local gives ONE `y` diff (the first element below it, `jump: 60`), not one per element below.
- **Font faces**: every `@font-face` loaded on live and used by a measured element must also be loaded on local;
  otherwise a `kind: "font"` divergence is reported (a failing face renders the fallback with the SAME computed
  `font-family`, so only this check catches a 404/CORS font).
- Elements inside carousel/marquee/ticker tracks (see sections) are a `phase` exception: their `x` is not compared.
- Dynamic regions (`config.dynamicRegions`) are excluded from pairing and masked; content below is realigned by the
  region's height delta, and a `y` jump equal to that delta is an `explained-shift` exception. Animated GIFs are masked.
- Pixel diff of the full-page captures (pixelmatch, threshold 0.1, anti-aliasing ignored), overall and per
  400 px band, raw and masked. If pixels differ, both sides are captured again (no reload) up to twice and the
  lowest ratio is kept (`pixels.recaptures`): this removes raster flakes under CPU load; real differences persist.

Output: `live.png`, `local.png`, `diff.png` (red = different), `report.json`.

### report.json

```jsonc
{
  "route": "/about", "width": 1440,
  "live":  { "url": "...", "height": 7726, "stableHeight": 7726, "scrollWidth": 1440, "clientWidth": 1440, "bodyBg": "rgba(...)" },
  "local": { "url": "...", "height": 7786, ... },
  "pixels": { "ratio": 0.0123, "ratioMasked": 0.0123, "masks": 0, "comparedHeight": 7726,
              "bands": [{ "y0": 0, "y1": 400, "ratio": 0, "ratioMasked": 0 }], "recaptures": [] },
  "counts": { "live": 298, "local": 298, "paired": 298, "onlyLive": 0, "onlyLocal": 0, "elementsWithDiffs": 2 },
  "diffs": [
    { "key": "Our approach…", "kind": "text", "tag": "h2", "y": 2410, "prop": "y", "live": 2410, "local": 2470, "jump": 60 },
    { "key": "We do", "kind": "text", "tag": "h2", "y": 5003, "prop": "color", "live": "rgba(0,0,0,1)", "local": "rgba(200,0,0,1)" },
    { "key": "img:hero.webp", "kind": "media", "prop": "presence", "live": "present", "local": "missing" }
  ],
  "divergences": 3,          // = diffs.length (one entry per element × property, presence included)
  "exceptions": [ { "type": "gif-mask" | "dynamic-region" | "explained-shift" | "phase", ... } ],
  "checks": { "height": true, "hscroll": true, "bodyBg": true, "pixels": true },
  "ok": false                // divergences == 0 and every check true
}
```

Ratios are fractions (0.003 = 0.3%). `kind`: `text`, `control`, `media`, `font` (`prop: "loaded"`). `checks.hscroll` is false when local
scrolls horizontally and live does not. The pixel tolerance is `config.pixelTolerance` (default 0.003).

Reading it: fix the **first** `y` jump first (everything below often follows), then fonts/sizes, then colors.
`presence` entries are elements only one side has (missing text, extra wrapper text, image not loaded).

Exports for other tools: `preparePage`, `extract`, `pair`, `diffPairs`, `fullShot`, `measure({route, width,
browser, outDir, liveRoute, localRoute})` (returns the report), `summarize`, `dynamicRegions`.

## sections.mjs

```
node tools/migrate/sections.mjs --route /about --width 1440 [--root "#main"] [--json]
node tools/migrate/sections.mjs --routes /,/about --widths 1440,390 [--concurrency 2] [--quiet]
```

Sections are the visible children of `rootSelector` (`display: contents` flattened; a wrapper holding ≥ 80% of the
page, like Webflow's `.page-wrapper` or WordPress `.wp-site-blocks`, is replaced by its children). Every element of a
section is paired:

- by `idAttribute` (or `id`) when that value is **unique** on the page (Ycode `data-layer-id`);
- otherwise by DOM path (`tag:nth-of-type` chain) from the nearest ancestor with a unique id, or from the section
  (`S3 > div:1>div:2>p:1`). Webflow `data-w-id` only exists on animated nodes and Framer names repeat, so most
  elements there pair by path. Pairing counts are printed (`id 179 / path 44`).

For each pair: box relative to the section (fixed-position subtrees use viewport coordinates, absolute subtrees whose
containing block is outside the section use page coordinates, `display: contents` has no box) and ~55 computed
properties (display, flex/grid, gaps, padding, margin, font, line-height, letter-spacing, colors, borders, radius,
background, transform, blend, shadow, filter, overflow, z-index, object-fit, visibility…), plus % of differing pixels
per section, each side cropped from its own section top. Carousel/marquee tracks (`.swiper-wrapper`, `.w-slider-mask`,
`[class*=marquee]`… plus `config.phaseSelectors`) are a **phase exception**: x and transform are not compared.

Output: `sections.json` next to the measure files (`sections[]` with `hLive/hLocal`, `px`, `styleDiffs`, `diffs[]`;
`onlyLive[]`, `onlyLocal[]`, `exceptions[]`, `ok`), and `sections-summary.json` for multi-route runs.

## crop.mjs

```
node tools/migrate/crop.mjs --route / --width 1440 --y0 1200 [--y1 2100] [--local-y0 1260] [--measure]
```
`crop-<y0>-<y1>.png`: live on the left, local on the right. Uses the last measure captures (runs measure if missing
or with `--measure`). `--local-y0` offsets the local band when content above has a different height.

## states.mjs

```
node tools/migrate/states.mjs --route / --width 390 --target "#menu-button" --action click|hover|focus|none
node tools/migrate/states.mjs --route / --width 1440 --steps "hover:.nav a:nth-child(2),wait:300,unhover"
     [--samples 80,1000] [--scope "header"] [--label menu] [--no-scroll] [--no-clock] [--full] [--max 30]
```
Steps: `click:SEL`, `hover:SEL`, `focus:SEL`, `blur:SEL`, `unhover`, `wait:MS`, `scroll:Y`, `press:KEY`.
REST is measured with the mouse parked in a corner; after the steps, STATE is sampled at 80 ms (mid-transition)
and 1000 ms (settled). Hidden elements and boxes with `id`/`idAttribute` are included, plus transform, opacity,
visibility, display, clip-path, pointer-events, z-index, size and inset. Waits advance the fake clock AND real time
(CSS transitions). Steps target the first VISIBLE match. Playwright's "stable" actionability check waits for animation frames, which the
paused clock never delivers, so click/hover retry with `force`; a click that still fails falls back to a synthetic
`el.click()` (noted in the output).

Output in `states-<label>/`: `{live,local}-rest.png`, `{live,local}-state-<ms>.png`, `side-by-side.png`
(final state), `diff.png`, `report.json` (`sampled[]` with REST→STATE changes per site and live×local divergences;
`*` in the terminal marks divergences that did not exist at REST).

## motion.mjs

```
node tools/migrate/motion.mjs --route / --width 1440 --selectors "h1,.hero img,[data-w-id=abc]"
     [--mode load|scroll] [--duration 3000] [--interval 50] [--scroll-to 1200] [--scroll-steps 20] [--real] [--rows 25]
```
Samples per selector (first match): opacity (own and effective), transform decomposed (tx, ty, sx, sy, rot),
visibility, display, filter, clip-path, bounding rect. `load`: from the load event, one sample per `--interval` of fake
clock. `scroll`: scrolls 0 → `--scroll-to` in steps. `--real`: real time instead of the fake clock, **required for
CSS transitions/animations** (timestamps approximate, samples paired by index). Prints the rows where something
changed and a verdict per selector: start/end equal, max |live − local| per property, change interval on each side.
Full samples: `motion-<mode>[-real].json`.

## run-all.mjs

```
node tools/migrate/run-all.mjs [--routes /,/about] [--widths 1440,390] [--concurrency 2] [--sections] [--out DIR] [--no-rerun]
```
Routes: `--routes`, else the latest snapshot manifest (status 200 + the 404 probe), else `config.routes`. Widths:
`config.widths`. Each run writes to its own folder (`--out`, else `$MIGRATE_OUT` as is, else
`<outDir>/runs/<timestamp>/`, recorded in `<outDir>/latest-run.txt`), so parallel runs never overwrite each other.
Output: per route/width folders, `summary.json` (`rows[]`: heights, `px`, `pxMasked`, divergences, `ok`, `flaky`,
`report` path) and `summary.md` (route × width table). Rows that fail under concurrency are measured again alone
once; if they pass they are kept and marked `flaky`.

## Known noise sources and exceptions

| Source | Handling |
|---|---|
| JS timers / rAF animations | fake clock, same frame both sides |
| `Math.random` (random first slide, shuffles) | seeded on both sides |
| Infinite CSS/WAAPI animations, marquees | frozen at 1 s; tracks are a phase exception in sections |
| CSS transitions | follow real time; settle waits; use `motion --real` to compare them |
| Lazy images, failed image loads | eager + `naturalWidth` wait + 3 reloads + decode |
| Live font host down / slow | served from the mirror file when it exists |
| Animated GIFs | masked (`gif-mask`); frame depends on load time |
| CMS-randomized blocks, embeds, counters | `config.dynamicRegions` (+ `reason`): masked, unpaired, realigned |
| Raster flakes under CPU load (blank tile, earlier frame) | automatic recapture; run-all reruns failed rows alone |
| Heavy sites with real-time races in their own JS (layout measured before fonts, chained `transitionend`) | can still differ under load: rerun with `--concurrency 1`; a difference that never reproduces alone is noise |
| Cross-origin iframes (YouTube, maps), canvas/WebGL | paired by order only; content not comparable — add to `dynamicRegions` if it varies |
| Cookie banners / A-B tests on live | add their container to `dynamicRegions` |

Self-check: point `live` and `local` at the same public site; every tool must report 0 divergences and ~0% pixels.
