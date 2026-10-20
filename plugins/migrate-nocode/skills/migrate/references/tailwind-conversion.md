# Phase 5b: CSS → Tailwind (Webflow, Framer, WordPress)

Ycode sites already are Tailwind: skip this phase. For the others, the target is **Next.js + Tailwind v4**, with plain
CSS only for what Tailwind can't express. The measurement tools are what make it safe: `sections.mjs` compares ~45
computed properties per element, so a drift shows up as a number, not as a feeling.

## Order: verbatim first, then convert
1. **Baseline**: pages are migrated with the platform CSS imported as-is (phases 2–5). Every page and width measures
   clean and is committed. This baseline is the reference of what each class does, and the revert point.
2. **Convert section by section** (below). After each section: measure, commit. Never convert a page in one go.
3. **Delete the platform CSS** only when nothing references it. What remains goes to `styles/legacy.css`.

The user can opt out at intake ("keep the platform CSS"); then stop after the baseline and record it as pending.

## Converting a section
1. Read the computed values from the baseline (`measure`/`sections` output, or `getComputedStyle` in the headless
   browser). The original class names tell you intent; the computed values tell you the truth. For hashed Framer
   classes and Elementor classes the computed values are the only source.
2. Write the utilities with **arbitrary values where exact**: `pt-[37px]`, `text-[17px]/[1.4]`, `tracking-[-0.02em]`,
   `w-[min(100%,1200px)]`. Snap to the Tailwind scale only if the measured result stays identical (`p-4` equals
   `16px`; `p-[15px]` doesn't snap). Exactness first, tidiness second.
3. Repeated values become tokens in `@theme` (colors, font families, radii, shadows, spacing that appears 3+ times),
   named after the platform's own variables so the mapping is traceable.
4. Responsive: use the platform's real breakpoints. Webflow is desktop-first (`max-width: 991px / 767px / 479px`);
   define them with `@custom-variant` (e.g. `@custom-variant tablet (@media (max-width: 991px));`) or arbitrary
   variants (`max-[991px]:`), not by overriding `--breakpoint-*`. Framer and Elementor: take the breakpoints from the
   snapshot's media queries. After conversion, check the order of the generated CSS at 390 and 768: wrong order is
   the usual cause of a broken mobile.
5. States: hover, focus, active, `group-hover`, `peer-*`, `has-[...]`, `data-[state=...]` cover most cases. Run
   `states.mjs` on every converted interactive element; lost hover rules are the most common silent regression.
6. Measure at 1920, 1440, 768 and 390 with `sections` and `measure`. Zero divergences, or revert the section.

## What stays CSS (small, named, commented)
Put these in `styles/legacy.css`, each with a comment saying why Tailwind didn't fit:
- hover or state driven by a **different** element that has no common ancestor to use `group`/`peer` on;
- `@keyframes` and animation timelines (they can still be referenced from `@theme --animate-*`);
- third-party library CSS (Swiper, Slick, lightbox, Elementor widget internals): keep it as the library ships it;
- complex selectors (`> * + *`, `:nth-child` patterns across many nodes, `@supports`, scroll-driven animations);
- `@font-face`, resets and platform variables that are used by scripts.

Try Tailwind first (arbitrary variants like `[&>*+*]:mt-4` are often enough). Falling back to CSS is normal; hiding
it is not: report the size of `legacy.css` in the final report.

## Drift that preflight introduces (check these first when a section moves)
Tailwind's preflight is not the platform's normalize/reset:
- `img`, `video`, `svg` become `display: block` (platforms often leave them inline: spacing under images changes);
- headings and paragraphs lose margins, lists lose bullets and padding;
- `button` and form controls: font, color and `cursor` reset (add `cursor-pointer` where live has it);
- `border-style: solid` and `box-sizing` defaults;
- `line-height` inherited as unitless vs `normal`.
Replicate the platform's base in `@layer base` once (Webflow's `w-*` base, WordPress theme base), then convert.

## Done
- Each converted page measures clean at four widths, with states and motion unchanged.
- No platform stylesheet imported by pages that were converted; `legacy.css` documented and small.
- No leftover `!important` that the platform CSS needed (Webflow/Elementor use it often): if one is still needed,
  record why.
- Decision record in `docs/decisions/` with what stayed CSS and the final `legacy.css` size.
