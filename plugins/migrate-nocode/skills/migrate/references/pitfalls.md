# Foundation pitfalls (each one cost hours on a real migration)

Apply all of them in phase 2, before converting pages. Measure the Home after foundations: divergences should drop
from dozens to a handful. If they don't, the cause is almost always one of these.

## Fonts
1. **Use the exact font files the live site serves** (woff2 from Google Fonts, OTF on a Supabase bucket, a theme's
   TTF…), hosted locally, with the same `@font-face` (family name, weight range, style, `unicode-range`) and the
   same class names. `next/font` ships different metrics and changes line breaks. Variable fonts: `font-weight 100 900`.
2. **Check every weight is actually loaded** (DevTools → Rendered Fonts, or `document.fonts`). A "300 that changes
   nothing" was never declared. Before blaming spacing, blame the font.
3. The live font host can go down mid-migration (it happened: the live site itself fell back to a system font). The
   measure tool serves the mirrored copies to the live side when the host fails.

## Base styles
4. **Body font stack and color**: builders often leave unclassed text in the system font and `body{color:#000}`.
   Forcing the brand font or another color on `body` misaligns everything.
5. Body class and background color are **per page**, not global.
6. `lang` on `<html>` exactly as live (case included, e.g. `pt-br`).

## CSS strategy
7. **Platform CSS verbatim and in the same cascade order as the live HTML.** If you also use Tailwind, keep the
   platform CSS outside `@layer` so it beats utilities like it does on live.
8. Tailwind sites (Ycode): same Tailwind major/minor as the live `<style>`; **native** breakpoints (`max-md:`,
   `max-lg:`). Redefining `screens` reverses the generated order and breaks mobile. `source(none)` + explicit
   sources so snapshots and docs don't bloat the CSS.
9. Non-Tailwind sites (Webflow, Framer, most WordPress): bring the downloaded stylesheets in first (with `url()`
   rewritten to the mirror, class names kept in JSX) as the measured baseline, then convert to Tailwind section by
   section in phase 5b ([tailwind-conversion.md](tailwind-conversion.md)). Never do both in one step: when something
   diverges you must know whether the migration or the conversion caused it.
10. Modern `browserslist` in package.json, otherwise Lightning CSS rewrites modern colors (`color-mix`, `oklab`) to
    `lab()`. Compare RENDERED colors (the measure tool does), not computed strings.
11. Platform variables (Ycode `--<uuid>` color vars, Webflow `--` variables, Framer tokens) declared exactly.
12. Elements hidden per breakpoint (Ycode `data-gsap-hidden`, Framer `hidden-*` variants, Webflow
    `w-condition-invisible`): keep the attributes and the whole structure, not only what is visible at one width.

## Images and media
13. Same URL variant and the same `srcset`/`sizes` as live, with `<img>` (not `next/image` in this stage), so the
    browser picks the same file and pixels match. Every `<img>`/SVG with intrinsic `width`/`height` (a logo without
    them measured 0 px tall and the hero script centered it 85 px too high).
14. CDNs re-encode: the platform optimizer can regenerate variants after your snapshot, or serve JPEG vs WebP by
    `Accept`. `assets.mjs --verify` re-downloads changed bytes.
15. Animated GIFs show a time-dependent frame: masked in pixel diffs.

## JavaScript and runtime
16. **Same library versions** as live (GSAP, Swiper, Lenis, jQuery plugins), found by banner or code fingerprint. A
    builder can embed one GSAP in its runtime and load another in custom code: replicate both (npm alias).
17. **StrictMode runs effects twice in dev**: every ported script cleans up on unmount (`gsap.context().revert()`,
    slider `destroy`, remove clones and `*-initialized` markers, kill only your own ScrollTriggers).
18. **Never put a `<script>` inside a React component** (Next 16: "Encountered a script tag while rendering React
    component"). A script that must run before hydration (hero pre-init, theme) is emitted only in the server HTML
    (e.g. a component using `useSyncExternalStore` to render it on the server only) or placed in the root layout.
19. **Final visual state in a CSS class**, never only in an inline style left by an animation (a logo turned black
    after a breakpoint change because its white came from an inline `filter` the runtime later cleared).
20. Containers with `display: contents` (Ycode `#ybody`) break Next's scroll-to-top on navigation: on every pathname
    change call `scrollTo(0,0)` (and your smooth-scroll library's immediate scroll) and close the mobile menu.
21. Client navigation (`next/link`) differs from live full reloads: reset scroll, menus and observers per route.
22. View Transitions: keep any safety timeout under 4 s and catch `ready`, `finished` and `updateCallbackDone`
    ("Transition was aborted because of timeout in DOM update").
23. Controlled form controls (`value`, not `defaultValue`) or the bfcache restores stale state.
24. Tailwind v4 preflight sets `cursor: default` on buttons: add `button,[role=button]{cursor:pointer}` if live has it.
25. Every text whose font-size changes per breakpoint needs an explicit line-height, or it inherits a loose one.

## Build and tooling
26. The visual build must pass **without a database or tokens** (the site reads JSON in this stage). Make CMS/Blob
    tokens optional in config.
27. Lint and Tailwind must ignore `snapshots/**` and `tools/out/**`.
28. After adding a new CSS `@import`, restart dev or `curl` the served CSS: Turbopack sometimes misses it.
29. Generators (header/footer from snapshot) must never overwrite manual edits: lock or remove the generator once a
    file is edited by hand, and note it.
30. Hide the Next dev indicator in captures (the measure tool does).
31. macOS has no `timeout`; chained `sleep` may be blocked; long commands go to the background.
