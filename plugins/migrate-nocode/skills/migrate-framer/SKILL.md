---
name: migrate-framer
description: Framer-specific knowledge for migrating a Framer site to Next.js with pixel fidelity (SSR CSS verbatim, breakpoint variants, appear and scroll animations, framerusercontent assets) and exporting its CMS collections. Use with the `migrate` skill whenever the site is on Framer (framerusercontent.com, data-framer-* attributes, framer-<hash> classes), the user mentions Framer, Framer CMS, or "sair do Framer".
---

# Framer → Next.js

Follow the `migrate` skill for the method; this file holds what is specific to Framer.

## Markers and config
`<div id="main" data-framer-hydrate-v2>`, classes `framer-<hash>`, attributes `data-framer-name`,
`data-framer-component-type`, `data-framer-appear-id`, a `<style data-framer-css-ssr…>` block, assets and fonts on
`framerusercontent.com` (images with `?scale-down-to=` and `srcset`), generator meta "Framer". Config:
`"platform": "framer"` (root `#main`; `data-framer-name` is a hint, not unique, so section pairing falls back to
DOM paths).

## CSS strategy: keep Framer's CSS
Framer's CSS is generated with hashed classes. **Copy the SSR `<style>` blocks verbatim** (in head order) and keep the
class names; don't try to make them readable in this stage. Fonts: Framer serves its own font files (and Google
Fonts) — mirror them and keep the same `@font-face`.

**Breakpoints are variants.** Framer renders every breakpoint variant of a component in the SSR HTML and hides the
inactive ones with `hidden-<hash>` classes inside media queries (common: desktop ≥ 1200, tablet 810–1199, phone
< 810, plus custom ones). Replicate the whole structure, all variants, or one width will be empty. Measure also at
the variant edges (809/810, 1199/1200).

## Animations
- **Appear (entrance) effects**: elements with `data-framer-appear-id` start with inline initial styles
  (opacity/transform) and are animated by a small script with the appear data (initial/animate values, transition
  spring or tween, delay). `snapshot.mjs` saves it in `facts → platform.appear`.
- **Scroll, hover, tap, page effects and "scroll transforms"** run in Framer Motion inside the hydrated app; they are
  not in the HTML. Sample them with `motion.mjs` (`--mode scroll` and `--mode load`) and `states.mjs` on live, then
  reproduce with **Motion** (`motion`/`framer-motion`, the same library) using the same values. Springs: Framer's
  defaults are visible in the appear data (`type: "spring", stiffness, damping, mass` or `bounce` + `duration`); match
  them by sampling, not by eye.
- Tickers/marquees and carousels from Framer components: speed in px/s, measure on both sides.
- Code components and overrides (custom React in the project) are compiled into the bundle: identify their behavior
  by sampling and rebuild them; record each one in `docs/decisions/`.

## Navigation and runtime
Framer is a client-routed React app: page transitions, scroll restoration and `Link` behaviors exist. With
`next/link`, reset scroll and state per route. Localized Framer sites use path prefixes per locale.

## Things that change under you
Image variants generated on demand (`scale-down-to`), CMS-driven lists, A/B variants, and the "Made in Framer"
badge on free plans (record, don't copy).

## CMS content (stage 2)
Framer CMS collections can be exported to CSV from the CMS panel (or the CMS Export plugin). Normalize with
`node tools/migrate/platform/framer-csv-import.mjs exports/*.csv --out content/`. With API access,
`framer-api-dump.mjs` (needs the optional `framer-api` package and a key in `.env.local`) dumps collections and
`framer-csv-import.mjs --api-json` normalizes them. Other options (plugins/APIs,
scraping the published CMS detail pages from the sitemap) are in [references/content.md](references/content.md).
Then follow the `migrate-content` skill.
