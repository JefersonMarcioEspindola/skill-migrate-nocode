---
name: migrate-webflow
description: Webflow-specific knowledge for migrating a Webflow site to Next.js with pixel fidelity (webflow.css verbatim, IX2 interactions, w-* components, breakpoints) and exporting its CMS through the Webflow Data API or CSV. Use with the `migrate` skill whenever the site is on Webflow (data-wf-site, website-files.com assets, webflow.js), the user mentions Webflow, Webflow CMS collections, or "sair do Webflow".
---

# Webflow → Next.js

Follow the `migrate` skill for the method; this file holds what is specific to Webflow.

## Markers and config
`<html data-wf-site="…" data-wf-page="…">`, stylesheet `<site>.webflow.css` (or `.shared.*.css` + per-page CSS) on
`cdn.prod.website-files.com` (older: `uploads-ssl.webflow.com`), `webflow.js` (or chunked `webflow.*.js`), jQuery
from a CloudFront URL, elements with `data-w-id`, classes `w-nav`, `w-slider`, `w-tabs`, `w-dropdown`, `w-lightbox`,
`w-form`, `w-dyn-list`. Config: `"platform": "webflow"`.

## CSS strategy: keep Webflow's CSS
Webflow doesn't use Tailwind. **Do not rewrite styles.** Import the downloaded stylesheets verbatim (`assets.mjs`
writes copies with `url()` pointing to the local mirror) in the same order as the live `<head>`, and keep every class
name in JSX (combo classes included: `button is-secondary`). Webflow's normalize + base `w-*` rules are part of
that CSS. Page-level `<style>` from custom code goes into a per-page CSS file or the component.

Breakpoints are desktop-first: `max-width: 991px` (tablet), `767px` (mobile landscape), `479px` (mobile portrait),
plus optional larger `min-width: 1280/1440/1920px`. Measure also at 991/767/479 ± 1 when layouts jump there.
Webflow variables appear as `--` custom properties in the CSS; they come along with the stylesheet.

## Interactions (IX2)
- The **initial state** is inline in the HTML (`style="opacity:0;transform:translate3d(0,40px,0)…"` on `data-w-id`
  elements) — keep it in the JSX or the first paint differs.
- The **definition** (events + actionLists + continuous scroll animations) is a JSON object passed to
  `Webflow.require('ix2').init({...})` inside webflow.js; `snapshot.mjs` extracts it to `facts → platform.ix2`. Each
  event: trigger (`PAGE_START`, `SCROLL_INTO_VIEW`, `SCROLLING_IN_VIEW`, `MOUSE_CLICK`, `MOUSE_HOVER`,
  `PAGE_SCROLL`, `MOUSE_MOVE`…), target (`data-w-id` or class), action list with action groups (each group runs after
  the previous; actions inside a group run together), `duration`, `delay`, `easing`, and breakpoints (`main`,
  `medium`, `small`, `tiny`).
- Two faithful options, decide per site and record it:
  1. **Keep webflow.js** loaded as a client script and the original `data-w-id`/`data-wf-page` attributes. Most faithful
     for complex IX2 (scroll-scrubbed, mouse-move). Needs re-init on client navigation (`Webflow.destroy();
     Webflow.ready(); Webflow.require('ix2').init()`) and full-page navigation or careful handling.
  2. **Port to GSAP/Motion** from the extracted JSON (same durations, delays, easings, groups). Cleaner, testable,
     preferred when interactions are simple (fade/slide on scroll, hover, nav open).
  Easing names map to cubic-beziers (`ease`, `easeIn`, `easeOut`, `inOutQuart` → `cubic-bezier(0.76,0,0.24,1)`,
  `outQuart` → `cubic-bezier(0.25,1,0.5,1)`, `outExpo` → `cubic-bezier(0.16,1,0.3,1)`…). Verify with `motion.mjs`.
- `w-*` components (nav menu open/close and its overlay, slider with dots/arrows/autoplay, tabs, dropdowns,
  lightbox) depend on webflow.js: reproduce their behavior and states, measure with `states.mjs`.

## Forms
Webflow forms post to Webflow; outside Webflow they need a backend. Visual stage: same markup and the success/error
blocks (`w-form-done`, `w-form-fail`) measured as states; the real handler waits for the content stage.

## Things that change under you
CMS lists (`w-dyn-list`) with random or limited sorting, "Made in Webflow" badge on free plans (record, don't copy),
CDN image variants (`-p-500.jpg` responsive variants in `srcset`), Lottie animations (`data-animation-type="lottie"`,
mirror the JSON), embedded fonts via WebFont loader (Google Fonts in `WebFont.load`).

## CMS content (stage 2)
Two paths, both documented in [references/content.md](references/content.md):
- **Data API v2** with a read-only token (`WEBFLOW_API_TOKEN` in `.env.local`, scopes `cms:read sites:read`):
  `node tools/migrate/platform/webflow-cms-export.mjs --site <siteId> --out content/` (collections, fields, items,
  locales, references, rich text, images; paginated with rate-limit backoff).
- **CSV export** per collection from the Designer when there's no token:
  `node tools/migrate/platform/webflow-csv-import.mjs exports/*.csv --out content/`.
Then follow the `migrate-content` skill. Ecommerce and Memberships are out of scope: record them.
