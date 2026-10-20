---
name: migrate
description: Migrate a live website built on a no-code platform (Ycode, Webflow, Framer, WordPress/Elementor) to a coded Next.js project that looks IDENTICAL to the live site, with pixel-level measurement, a side-by-side /review page and a later CMS content stage. Use this whenever the user wants to move a site off Ycode, Webflow, Framer, WordPress, Wix-like builders or "no-code" to code, rebuild or clone a live site pixel-perfect, "sair do Webflow/Framer/Ycode/WordPress", "migrar site para código", or compare a rebuilt site against the live one, even if they don't say "migration".
---

# Migrate a no-code site to code, pixel-perfect

You are the ORCHESTRATOR of a fidelity migration. The live site is the source of truth; the goal is a Next.js
project whose pages are indistinguishable from it at 1920, 1440, 768 and 390 px, proven by measurement, not by eye.

The method in one sentence: **convert, don't interpret.** Snapshot the rendered HTML of every route, convert it to
JSX keeping the original classes and CSS, measure live vs local in a headless browser, fix until the measured
difference is zero. Every fix comes from a measured value, never from "looks the same". Rewriting styles *before* there is a
measured baseline is what makes migrations end up *similar* instead of *identical*; once a page measures clean,
rewriting (e.g. platform CSS → Tailwind, phase 5b) is safe, because every step is measured against that baseline.

Talk to the user in their language. Work autonomously once intake is done.

## 0. Intake (ask once, then work)

Detect first, ask second. Run the platform detector on the URL before asking anything:

```bash
node <this skill dir>/scripts/detect.mjs https://example.com
```

Then ask only what you can't infer, in ONE message (use the question tool if available). Full question list with
defaults and why each matters: [references/intake.md](references/intake.md). The essentials:

1. Live URL (and confirm the detected platform).
2. Project folder / repository, and whether to start from an existing template or scaffold Next.js + TypeScript.
3. Scope: visual only now (recommended), or visual + CMS content.
4. Languages and how they're routed on the live site.
5. Optional inputs: Figma links, platform backup/export (Ycode `.ycode`, Webflow API token or CSV, Framer CSV,
   WordPress folder / `.sql` dump / REST), and where the CMS content should land later.
6. CSS target (non-Tailwind platforms): convert to Tailwind after the visual baseline is clean (default), or keep the
   platform CSS ([references/tailwind-conversion.md](references/tailwind-conversion.md)). And the polish layer: keep 100%
   faithful, or apply the optional finishing layer after fidelity ([references/polish.md](references/polish.md)).
7. Git: branch or straight to main; push/deploy only on explicit request (default).

Then load the platform skill — `migrate-ycode`, `migrate-webflow`, `migrate-framer` or `migrate-wordpress` — it
holds what is different on that platform (CSS strategy, ids, animations, assets, content export). For anything else
(Wix, Squarespace, static HTML) continue with this skill alone and the generic rules.

## Non-negotiables

- **Read-only on the live site**: GET requests, polite concurrency (≤ 4). The client owns the site and authorized it.
- Never read, print or commit `.env` values, API tokens, `wp-config.php` credentials or backup secrets.
- Never write to a database in the visual stage. Content seeds go to a dev branch/database only, later.
- No deploy, no push, no `npm audit fix` without the user's explicit OK.
- Never invent content. Bugs of the old site are replicated first, then reported (see "Errors of the old site").
- Measure against a **production build** (`next build && next start -p 3100`), not `next dev`: dev mode double-runs
  effects, shows overlays and compiles mid-measurement. Agents never stop or restart the shared server.

## Phases

Track them in `docs/layout-loop.md` (the BOARD: one row per item with last measured numbers, state and commit) so
the work survives usage limits and context compaction; the user resumes with "continue the board". Details and the
reasons behind each rule: [references/method.md](references/method.md).

| # | Phase | Output |
|---|---|---|
| 0 | Setup: project, deps, copy tools, `migrate.config.json` | tools in `tools/migrate/`, config |
| 1 | Reconnaissance: snapshot every route, facts, assets, board | `snapshots/<date>/`, `docs/layout-loop.md`, one question list |
| 2 | Foundations: fonts, base CSS, breakpoints, colors, images, runtime | Home measured, divergences down from dozens to a few |
| 3 | Shared components: header variants, mobile menu, footer, forms | measured in 3 widths and every state |
| 4 | Pages in parallel (≤ 3 agents at once) | every page at 0 divergences |
| 5 | Motion: every trigger, tween, easing, stagger, breakpoint | motion sampled equal on both sides |
| 5b | CSS → Tailwind (Webflow, Framer, WordPress; skipped on Ycode): section by section, measured | Tailwind v4 with a small documented `legacy.css` |
| 6 | Optional polish layer (only if the user wants it) | deviations recorded in `docs/decisions/` |
| 7 | SEO & metadata, redirects, brand 404 | head-check clean |
| 8 | `/review` page (skill `migrate-review`) | side-by-side page, regenerated after each batch |
| 9 | Final verification: re-sync with live, independent verifiers, code review, publish checklist | zero measured divergences |
| 10 | Final report + open `/review` | report, pending list by owner, deploy checklist |
| 11 | (Later) CMS content stage (skill `migrate-content` + platform skill) | normalized `content/*.json`, importer |

### Phase 0: setup

```bash
mkdir -p tools/migrate && cp -R <this skill dir>/scripts/* tools/migrate/
cp -R <platform skill dir>/scripts tools/migrate/platform      # if the platform skill has scripts
mkdir -p tools/migrate/review && cp -R <migrate-review skill dir>/scripts/* <migrate-review skill dir>/assets/review-template.html <migrate-review skill dir>/assets/review-route.ts tools/migrate/review/
npm i -D playwright-core pixelmatch pngjs parse5 sharp && npx playwright-core install chromium
```

Write `migrate.config.json` at the project root ([references/config.md](references/config.md)). Copying the tools
into the project is deliberate: they get committed with the migration, agents can patch them per site, and the
project stays reproducible without the skill installed. Tool docs: [references/tools-capture.md](references/tools-capture.md),
[references/tools-compare.md](references/tools-compare.md), [references/tools-qa.md](references/tools-qa.md).

### Phase 1: reconnaissance

```bash
node tools/migrate/snapshot.mjs          # rendered + raw HTML, facts, manifest, dated
node tools/migrate/assets.mjs            # mirror every asset with a stable local path
node tools/migrate/intent-check.mjs --target live   # bugs the live site already has
```

**If the user has a backup or dump, use it now to understand the CMS structure, not to move content.** The visual
stage renders collections from fixed JSON, so you need the real shape before writing the templates: which collections
exist, their fields and types, which pages are dynamic (one template per collection), which lists are randomized or
limited, and how many items there are. Run the inventory only (it prints structure, key names and counts, never
values):

```bash
node tools/migrate/platform/ycode-backup-inventory.mjs path/to/site.ycode     # Ycode
node tools/migrate/platform/wp-inventory.mjs --folder legacy/wordpress --dump legacy/dump.sql   # WordPress
```

Webflow and Framer have no structure-only mode: read the collections from the snapshot (`w-dyn-list` and CMS item
pages on Webflow, CMS detail pages in the Framer sitemap) and, if the user has a CSV export, its header row. Use the
result to shape `lib/data/<collection>.json`, to decide which routes are template-driven, and to fill the "waits for
the CMS stage" list. If an inventory reports a populated secret (an API key in builder settings), tell the user so the
owner can revoke it. Content export is still stage 2 (`migrate-content`).

Record the snapshot date: the live site changes during the work (clients publish, CMS blocks reshuffle, CDNs
re-encode images). Build the board, then send the user ONE list and keep working on what doesn't depend on it:
Figma × live differences, pages that look like template leftovers, untranslated locales, odd redirects, dead links,
typos (obvious typos: fix and record), and the visual bugs of the live site. No answer means the live site wins.

### Phases 2 to 5

Foundations first, measured on the Home, before any page work — the traps that cost hours are in
[references/pitfalls.md](references/pitfalls.md) (fonts, base body styles, breakpoints, CSS order, images,
library versions, StrictMode, inline scripts). Then shared components, then pages in parallel following
[references/agents.md](references/agents.md), then motion.

```bash
node tools/migrate/tojsx.mjs --page about --list
node tools/migrate/tojsx.mjs --page about --section 2 --name AboutSection2 --out app/about/_sections/section-2.tsx
node tools/migrate/measure.mjs --route /about --width 1440     # also 1920, 768, 390
node tools/migrate/sections.mjs --route /about --width 390
node tools/migrate/states.mjs --route / --width 390 --target "#menu-button" --action click
node tools/migrate/motion.mjs --route / --width 1440 --mode load --selectors ".hero h1"
node tools/migrate/run-all.mjs --sections
```

Content that comes from the CMS (lists, posts, case studies) is fixed data in this stage: extract it from the
snapshot into `lib/data/<collection>.json`, render with ONE template per collection, and check every route with
`verify-dom.mjs`. Record in `docs/pendencias.md` (or `docs/pending.md`) what waits for the CMS stage.

### Phase 5b: CSS → Tailwind (Webflow, Framer, WordPress)

Only after the pages above measure clean with the platform CSS imported as the baseline (commit it: it is the revert
point). Convert section by section, measure after each one, keep a small documented `legacy.css` for what Tailwind
can't express. Skip it on Ycode (already Tailwind) or when the user chose to keep the platform CSS. Rules, drift
to check first and what stays CSS: [references/tailwind-conversion.md](references/tailwind-conversion.md).

### Definition of done (per page and width, against the production build)

- 0 divergences in `measure` and 0 divergent properties in `sections` (vertical offset explained by a recorded
  content exception is fine; polish deviations recorded in `docs/decisions/` are fine).
- Document height equal, or the difference attributed to a recorded exception.
- Differing pixels below ~0.3% (image/video compression, GIFs and randomized blocks are declared exceptions).
- `texts` and `head-check` clean; `verify-dom` clean on template collections; `intent-check` clean.
- Hover, focus, menu, accordions, forms and animations measured on both sides; no horizontal scroll.

Full criteria and how to declare exceptions: [references/criteria.md](references/criteria.md).

### Phase 9: final verification

1. **Re-sync**: `snapshot.mjs --fresh`, then `texts.mjs --from <first> --to <new>`, compare routes, redirects,
   head and asset bytes (`assets.mjs --verify`); apply what changed on live (unless decided otherwise) and re-measure.
2. **Independent verifiers** — agents that did NOT build the page — run measure, sections, texts and intent-check and
   return MEASURED divergences per section. They find what self-measurement misses (select arrows, checked
   checkboxes, entrance sequence, loading states, focus after Enter, JSON-LD fields, new redirects on live).
3. Independent code review and a publish checklist (SEO, structural accessibility, performance, forms, deploy).
   It usually fails the first time on client-owned items (credentials, content, contrast): that becomes the
   pending list, which is normal.

### Phase 10: final report, then open /review

Use the template in [references/report.md](references/report.md): page × width table (height, pixel %,
divergences), exceptions and deviations, pending items by owner (client / dev / content), what waits for the CMS
stage, a deploy checklist (is a database needed now? env vars, asset weight, domain, redirects), a short message
the user can paste to the client, and the recommended next step. Then regenerate the review page and **open it**:

```bash
node tools/migrate/review/build-review.mjs --measure --open
```

The review page is how the user and the client see the result; always end with it open.

## Errors of the old site

- Content errors (two pages with swapped content, wrong link, duplicated item): replicate, record, ask at the end
  whether to keep or fix. To measure pages with swapped content, measure crossing the routes.
- Visual bugs (text breaking on mobile, horizontal scroll, off-center hero, header without contrast): replicate and
  measure first, then fix in a separate commit and record it as an improvement over live.

## Usage limits and resuming

Big migrations burn a lot of usage. Before each batch of agents: commit and update the board. Each agent writes
progress to `docs/agents/<item>.md`. When a limit stops agents, resume the SAME agent (tell it what changed while it
was stopped) instead of starting a new one. Before any pause leave `docs/layout-loop.md`, `docs/changelog.md` and the
pending list updated and committed.

## Documentation kept in the project

`docs/layout-loop.md` (board), `docs/changelog.md`, `docs/pendencias.md` (by owner), `docs/agents/`, and
`docs/decisions/` (fonts, breakpoints, runtime ports, fidelity vs best practice, every polish deviation).
Update them before every commit.
