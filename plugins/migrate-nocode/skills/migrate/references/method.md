# The method, phase by phase

## Source hierarchy (when they disagree, the one above wins)
1. The live site: rendered HTML, computed styles, captures.
2. Figma, if any: desktop values, favicon, share image, redesigned components the user explicitly asks for.
3. Figma-to-code exports: only font size, weight and color.
4. Platform backup/export: content only, for the CMS stage.

Text always comes from the live site, re-scraped the day you finish (phase 9). Before rebuilding a page, state
which source you used.

## Phase 1: reconnaissance, in detail
For each page record: sections, tokens (colors, fonts), `<head>` (title, description, canonical, OG, icons,
hreflang, JSON-LD), animations (platform data + custom code), assets, status/redirect, elements that change per
breakpoint. Also:
- **Runtime versions**: animation/slider/smooth-scroll libraries and their exact versions.
- **Locales**: mirror routes and whether they're translated.
- **Figma × live inventory**: texts, footer, components; pages or blocks that look like template leftovers.
- **404**: if live only has the platform default ("404 / Page not found"), plan a brand 404 (phase 7).
- **Visual bugs of live** (`intent-check --target live`): text breaking or spilling on mobile, horizontal scroll,
  fixed vh heights with text inside, off-center hero, header without contrast, images without size, state that
  breaks after a breakpoint change, `href="#"`, social labels without links.

The board in `docs/layout-loop.md`:

```markdown
# Layout loop: <client>
Source of truth: <live url> (snapshot snapshots/<date>/, platform published <date>). Widths: 1920/1440/768/390.
## Source hierarchy  …
## Rules  …
## Board
| # | Item | Last measured difference | State | Commit |
|---|---|---|---|---|
| 0 | Tools | | | |
| 1 | Foundations (fonts, CSS, images, layout per locale, metadata) | | | |
| 2 | Runtime: sliders / interactions | | | |
| 3 | Header (variants) | | | |
| … | one row per shared component, per page or template, motion, polish, SEO, review, verification | | | |
```

## Phase 2: foundations
Apply every item in pitfalls.md, then measure the Home at 4 widths. Typical order: platform CSS and fonts →
body/base → color variables → images (mirror + same srcset) → layout per locale → metadata from snapshot →
runtime ports (sliders, interactions, smooth scroll, custom code).

## Phase 3: shared components
Header (builders often have only 2–3 real variants; the rest is per-page id prefixes, locale and
`aria-current`), mobile menu, side panels, footer, language switch, forms. Convert, wire interactions, measure at
3 widths AND in every state (menu open/closed, hover, focus, accordion, form filled/error).

## Phase 4: pages
See agents.md.

## Phase 5: motion
Reproduce the extracted spec (every trigger, every tween — not only the first —, duration, delay, easing,
split text, stagger, breakpoints) and the custom code (smooth scroll, marquees, cursor trails, carousels). Distinct
interactions run in parallel (header vs content sequence). Check with `motion.mjs` on both sides. Respect
`prefers-reduced-motion`: animations jump to their final state, content always appears.

Common easing map: GSAP `power1.out` = `cubic-bezier(0.5, 1, 0.89, 1)`, `power2.out` = `cubic-bezier(0.33, 1, 0.68, 1)`,
`power3.out` = `cubic-bezier(0.22, 1, 0.36, 1)`, `power4.out` = `cubic-bezier(0.165, 0.84, 0.44, 1)`, `power1.inOut`
= `cubic-bezier(0.45, 0, 0.55, 1)`; Webflow "ease" = `ease`, "outQuart" = `cubic-bezier(0.25, 1, 0.5, 1)`.

## Phase 7: SEO and metadata
Title, description, canonical, OG, Twitter, icons per page identical to live (`gen-meta.mjs` + `head-check.mjs`);
sitemap with hreflang for every locale; robots; JSON-LD (Organization with addresses, WebSite; Article on posts with
`inLanguage` and the author shown on the page); 301 redirects of old URLs (WordPress `/?p=`, `/category/`, `/feed`,
date archives; Webflow/Framer CMS paths that change); brand 404 with `noindex`; correct `lang`.

## Phase 9: verification
See SKILL.md. Verifiers get the same brief as page agents plus "you did not build this; find what is different".
Give them the list of things verifiers found before (select arrows, checked checkboxes, entrance sequence, "load
more" spacing and loading state, hero flicker, focus after Enter, JSON-LD fields, redirects that appeared on live).
