# QA tools: texts, intent-check, verify-dom

Three checks that pixel measurement does not cover. All run from the project root, read `migrate.config.json`,
print a short summary and write details to `<outDir>/<tool>/*.json` (`MIGRATE_OUT` overrides `outDir`).
Shared helpers live in `tools/migrate/lib/qa.mjs`.

Default routes: `--routes /a,/b`, otherwise every route of the latest snapshot that answered < 400 on live, plus
`config.routes`, minus `excludeRoutes` and the 404 probe.

## texts.mjs — every visible string

```bash
node tools/migrate/texts.mjs [--routes /,/about] [--width 1440]          # live × local (rendered)
node tools/migrate/texts.mjs --from 2026-10-01 --to 2026-10-19T1900        # snapshot × snapshot (offline)
node tools/migrate/texts.mjs --only live|local|<snapdir>                   # flags of one side (reconnaissance)
  [--ignore-selectors ".cookie,.ticker"] [--concurrency 3] [--max 3] [--out name]
```

What it compares, per route, as multisets (order-insensitive), in six categories:
- `text`: rendered `innerText` of every visible text block (nearest block-level box of each text node).
  ASCII whitespace is collapsed; **NBSP is kept**, so `a b` → `a b` shows up as a change of kind `nbsp`
  (shown as `⍽` in the terminal).
- `head`: title, description, `og:*`, `twitter:*`, and `<html lang>` (live × local).
- `alt`, `placeholder`, `aria` (`aria-label`), `button` (button text / submit values).

Result per route: `added`, `removed`, `changed` (`{from, to, kind: nbsp|case|whitespace|punctuation|text}`) and `flags`.
Platform badges, Next.js overlays and `config.dynamicRegions` are skipped.

Snapshot × snapshot uses the saved HTML with parse5 (no layout: blocks by tag, `[hidden]` and inline `display:none`
skipped). Use it in the final re-sync to see what the client changed on live during the migration; routes that
appear or disappear are listed as `route added/removed`.

Flags (on the new side; in live × local, a flag that live already had is `inherited` and only counted):

| flag | catches |
|---|---|
| `placeholder` | lorem/ipsum, "placeholder", "Image description", "Exemplo" (Ycode/Webflow template leftovers) |
| `default-text` | builder defaults: "Heading", "Button Text", "This is some text inside of a div block.", "Sample Page"… |
| `code-leak` | `undefined`, `null`, `NaN`, `{{ }}`, `${ }`, `[object Object]` (JSX conversion bugs) |
| `literal-entity` | `&amp;`, `&nbsp;` rendered as text (double escaping) |
| `wrong-language` | block of ≥ 5 words (≥ 4 in head/alt/button) whose function words point to another language than the route's locale (en, pt, es, it, fr, de) |
| `duplicated-word` | "the the", "de de" |
| `space-before-punctuation` | "Spirit , 2026" (rendered mode only: offline HTML has no layout) |
| `repeated-letters` | 4+ repeated letters |
| `alt-filename` | alt like `IMG_2034.jpg`, `image`, `foto 3` |

The route's locale comes from `config.locales` (first path segment; unprefixed routes use `defaultLocale` or the first
locale), else from `<html lang>`. No spellchecker: typos beyond these patterns need a human or an agent read.

Done when: live × local has no `added/removed/changed` except recorded exceptions, and no new flags.

## intent-check.mjs — bugs the live site has too

```bash
node tools/migrate/intent-check.mjs                      # local (default)
node tools/migrate/intent-check.mjs --target live        # reconnaissance: the live site's own bugs
node tools/migrate/intent-check.mjs --target https://staging.example.com
  [--routes /,/about] [--widths 1440,390] [--checks a,b] [--skip resize,contrast]
  [--center "#logo"] [--center-tol 4] [--contrast-steps 5] [--contrast-widths 1440,390] [--concurrency 2] [--strict]
```

Output: `<outDir>/intent/<target>.json` (`findings` merged across widths, `raw` per route × width) and the resize
captures in `<outDir>/intent/<target>/<slug>/`. `--strict` exits 1 when there are errors.

| check | how | severity |
|---|---|---|
| `hscroll` | `scrollWidth > clientWidth` and whether the page really pans; culprits = outermost boxes or text runs past the edge that no ancestor clips | error if it pans, warn if hidden by `overflow-x` |
| `header` | at load (before any scroll), text blocks intersecting a fixed/sticky bar at the top; `covered` when the bar is on top at that point | error covered, warn overlapping |
| `overflow` | boxes with `scrollHeight > clientHeight + 1` whose text runs past the bottom; reported when clipped (`overflow: hidden/clip`) or when the box has a fixed height (it grows once `height`/`max-height` are released). Line clamps, ellipsis, scroll containers, absolutely positioned descendants and collapsed boxes are ignored | error |
| `links` | `href="#"`, empty, `javascript:` (error); no `href`, `#anchor` without target (warn); platform/dev URLs: `*.webflow.io`, `*.framer.website`, `*.ycode.site`, `/wp-admin`, `localhost`, `*.vercel.app` (error) | |
| `social` | LinkedIn, Instagram, Behance, X/Twitter, Facebook, YouTube, TikTok, Dribbble, WhatsApp… labels (text, alt, aria-label, svg title) not inside `<a href>` (error), or linking to another domain (warn) | |
| `cursor` | computed cursor of `a[href]`, `button`, `[role=button]`, submit inputs, `summary` (and of the element actually under the pointer at its center) must be `pointer`; `none`/`url()` count as a custom cursor. Tailwind v4 preflight leaves buttons at `default` | error; warn when covered by another element |
| `images` | broken (`naturalWidth 0`), no `width/height` nor CSS aspect-ratio/object-fit/absolute (layout shift), oversized (> 2.5× the rendered width) | error / warn / info |
| `center` | `--center "#logo"`: distance of the element's center to the viewport center at load | warn above `--center-tol` px |
| `resize` | desktop → mobile → desktop on one page while a control page stays at desktop, both under a paused fake clock advanced by the same amounts (JS carousels on the same frame), CSS animations disabled, real-time movers masked. Compares pixels and the boxes of the root's children/header/document size | error above 0.5% or any box change |
| `contrast` | at `--contrast-steps` scroll positions, each item of the fixed header (text, svg/img, burger bars) is captured, hidden and captured again: foreground = pixels that changed, background = median of the hidden capture; WCAG ratio | error < 1.5, warn < 3 (one finding per route × width) |

Example (a real Ycode site, live): `/contact` @390 pans +26 px (social labels overflowing a 62 px grid column),
`/about` @390 hero title under the header, white header items 1:1 on white sections at three scroll positions,
hero wordmark loses its white layer after a resize round trip, `href="#"` on a hidden "Taste all projects" link.

Run it on live in reconnaissance (Phase 1) and put the live bugs in the question list: fix or replicate is the
client's call. Run it on local before every review batch; on local it must be clean except the live bugs the client
chose to keep.

## verify-dom.mjs — template collections

```bash
node tools/migrate/verify-dom.mjs --match "/work/*"            # local server HTML × snapshot, every /work/ route
node tools/migrate/verify-dom.mjs --routes /work/a --render    # render local with Playwright (JS on)
node tools/migrate/verify-dom.mjs --snap 2026-10-01 --against 2026-10-19T1900   # snapshot × snapshot (offline)
  [--ignore "srcset,sizes,data-x-*,class:is-*"] [--ignore-selectors ".cookie,[data-random]"]
  [--exact-text] [--keep-whitespace] [--max 6] [--out name]
```

Compares the normalized DOM under `config.rootSelector` (Ycode `#ybody`, Framer `#main`, others `body`): tags,
classes (as a token delta `-old +new`), every attribute (`data-*`, `aria-*`, `href`, `src`, `alt`…) and text, with
children aligned by tag + first class (inserted/removed nodes are reported, the rest keeps comparing). Default
fetch mode reads the server HTML (no JS), which is what the JSX produces; `--render` compares after JS. Both sides
get the same normalization, so ignoring is symmetric:

- dropped: `script`, `style`, `link`, `meta`, `noscript`, comments, whitespace-only text; platform badges;
  `config.dynamicRegions`;
- inline styles written by animations: `transform`, `translate`, `rotate`, `scale`, `opacity`, `visibility`,
  `will-change`, `transition*`, `animation*`, `clip-path`, `filter`, `pointer-events`;
- runtime classes: Swiper state (`swiper-initialized`, `swiper-slide-active`…), Slick/Splide/Flickity/Glide state,
  `aos-init/aos-animate`, `lazyloaded`, `is-inview`, `animate__*`; runtime attributes: `data-*-initialized`,
  `data-swiper-slide-index`, `data-ll-status`, extension attributes;
- inside a carousel (`swiper*`, `splide*`, `slick*`…): `id`, `role`, `aria-*`, `tabindex`, `style`; carousel clones,
  Swiper bullets/notifications removed; GSAP `pin-spacer` wrappers unwrapped.

Diffs repeated on ≥ 50% of ≥ 3 routes (header, footer, shared components) are reported once under `shared` with
their count. Expected noise when comparing server HTML to a rendered snapshot: JS-set inline sizes (`height: 398px`),
marquee clones, alts or classes changed by scripts — decide per site and add `--ignore`/`--ignore-selectors`
(document the reason) rather than editing the snapshot.

Done when: every route of each collection is identical apart from recorded exceptions.
