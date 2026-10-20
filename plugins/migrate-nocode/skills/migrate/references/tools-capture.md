# Capture tools: detect, snapshot, assets, gen-meta, tojsx, head-check

Everything the migration needs from the live site, captured once and reused offline. Run from the project root
(`node tools/migrate/<tool>.mjs`). All tools except `detect` read `migrate.config.json`. They print a short summary;
details go to files. Shared helpers: `lib/capture.mjs` (HTML/CSS/URL/head parsing) and `lib/platforms/*.mjs`.

Order: `detect` → write the config → `snapshot` → `assets` → `gen-meta` → `tojsx` (per section) → `head-check`.

## detect.mjs — which platform is this?

```bash
node tools/migrate/detect.mjs https://www.example.com [--render] [--json]
```

Works without a config. Fetches the raw HTML (plus a Chromium render when inconclusive or with `--render`), scores
each platform's markers and prints the evidence, the root-selector section count and a starter config:

```
detect https://x.webflow.io/ -> webflow (score 14, from raw HTML); HTTP 200
  evidence: data-wf-site="…"; data-wf-page="…"; generator meta Webflow; webflow*.js runtime; …
  root body: 1 sections; single-child wrapper; 1 level(s) down there are 3 children (tojsx --list shows a --root hint)
  migrate.config.json: {"platform":"webflow","live":"https://x.webflow.io"}
```

Markers: Ycode (generator `Ycode`, `ycode-published-at`, `style#ycode-styles`, `#ybody`, `data-layer-id="lyr-…"`),
Webflow (`data-wf-site/page`, generator, `webflow*.js`, website-files CDN), Framer (generator `Framer …`,
`data-framer-hydrate-v2`, `data-framer-name`, `server: Framer`), WordPress (generator, `api.w.org` link/header,
`/wp-content/`, `/wp-includes/`).

## snapshot.mjs — the live site, frozen

```bash
node tools/migrate/snapshot.mjs                         # discover + snapshot every route
node tools/migrate/snapshot.mjs --only /,/about,404     # just these (no discovery); merges into the manifest
node tools/migrate/snapshot.mjs --routes-only           # discovery only -> routes.json (no browser)
  [--concurrency 3 (max 4)] [--fresh] [--date YYYY-MM-DD] [--width 1440] [--no-block] [--max-routes N]
```

Routes = sitemaps (robots.txt `Sitemap:` lines, else `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`;
sitemap indexes followed, `xhtml:link` alternates included) ∪ same-site links of the rendered home ∪
`config.routes`, minus `config.excludeRoutes` (glob `*`), plus `config.notFoundProbe` saved as slug `404`.
Admin/feed/cart/asset URLs are never routes. `/about` and `/about/` are one slug (`about`); the sitemap form wins,
so WordPress keeps its trailing slash.

Each page is rendered in Chromium (1440×900, DPR 1): `domcontentloaded` → `load` → network idle → wheel-scroll to
the bottom (lazy images, scroll-triggered content, inner scrollers too) → back to top → fonts ready. GET only;
analytics/beacon hosts are blocked (`--no-block` to allow). `--fresh` adds `?v=<ts>` and no-cache headers to the
document (CDN/HTML cache buster); the stored `finalUrl` drops it. The HTTP cache is shared within a worker.

Output `snapshots/<date>/`:

| Path | Content |
|---|---|
| `raw/<slug>.html` | Server HTML as received (pre-JS). **Source for tojsx**: initial states, every Framer variant, RSC payload. |
| `html/<slug>.html` | Rendered DOM after JS + scroll (final animation states, lazy `src` filled, one Framer variant). |
| `facts/<slug>.json` | Everything below. |
| `css/<host>/<path>.css` | Each stylesheet exactly as the browser got it (incl. `@import`ed and UA-dependent Google Fonts CSS). |
| `css/inline/<hash>.css` | Each distinct inline `<style>` (raw and JS-injected, CSSOM-only rules serialized). |
| `js/inline/<hash>.js` | Inline scripts to port by hand (RSC flight chunks and JSON-LD excluded). |
| `platform/…`, `custom-code/…` | Platform data files (IX2/IX3 JSON, Framer SSR/appear/handover, Ycode embeds). |
| `manifest.json` | date, live, platform (+ detected), userAgent, viewport, publishedAt, discovery, collections, routes[] (status, finalUrl, title, sizes, counts, platform summary), warnings. |
| `routes.json` | Discovered routes with their sources (sitemap / crawl / config). |

`facts/<slug>.json`: `status`, `finalUrl`, `redirects[]` (url, status, location), selected response `headers`,
`head` (see below), `headRenderedDiff` (head keys JS changed), `stylesheets[]` (href, media, how found, importedBy,
file, mirrored), `inlineStyles[]`, `scripts[]` (src or inline kind/file, async/defer/type, raw|rendered|both),
`fonts` (`faces` from all CSS with src URLs, `loaded` families, font `requests`), `assets[]` (absolute URLs) +
`assetKinds` (img, srcset, media, poster, bg, lazy, head, style-attr, inline-css, css, font, network, scan),
`root` (found in raw/rendered, skipped nodes), `sections[]` (raw: index, tag, id, classes, idAttribute, text, element
count), `sectionsRendered[]` (+ top, height, display), `links.internal[]`, `libs` (GSAP, ScrollTrigger, Swiper, Lenis,
jQuery, Lottie… from URLs, license banners and globals; several versions → array), `breakpoints` (min/max widths by
frequency), `metrics`, `network` (counts by type/host, failed, full list) and `platformFacts`.

`head`: lang, dir, htmlAttrs, bodyClass/bodyAttrs, title, description, robots, viewport, themeColor, generator[],
canonical, base, manifest, `og` (all `og:*`, `article:*`, `fb:*`; repeated keys → arrays), `twitter`, `hreflang[]`,
`icons[]`, `jsonLd[]` (types + parsed JSON), `metas[]` (all), `preloads[]`, `feeds[]`.

### platformFacts

- **ycode**: `interactions[]` `{layerId, interactions}` — the owner is the object that CONTAINS the `interactions` key
  in the RSC rows (its `id` = `data-layer-id`); `htmlEmbeds[]` (component `html` props / T rows with `<script>`,
  saved to `custom-code/`), `nextS`, `colorVars` (from `style#ycode-color-vars`), `styleIds`, `gsapInitialStyles`,
  `publishedAt`, `dplId`, `runtime.chunks`.
- **webflow**: `siteId`, `pageId`, `collectionId`/`itemSlug` (CMS template pages), `lastPublished`, `css`, `js`,
  `modules` (`Webflow.require` names), `components` (w-nav, w-slider, w-tabs, w-dropdown, w-lightbox, w-form,
  w-background-video, w-embed, w-dyn-*…), `cms`, `wIds[]` (data-w-id + the server inline style = IX initial state),
  `ix2` (whole data in `platform/webflow-ix2-*.json`; `page.events/actionLists` filtered to this page;
  `mediaQueries`), `ix3` (GSAP-based interactions + timelines, `page` filtered by scope), `breakpoints`, `lottie`,
  `backgroundVideos`. IX data is a JS object literal (unquoted keys, `!0`, `0x…`), parsed without evaluating code.
- **framer**: `siteId`, `routeId`, `localeId`, `breakpoints` (hash + media query, from `data-framer-hydrate-v2`),
  `ssrCss`/`breakpointCss` (files), `hiddenClasses` (`hidden-<hash>` → media query), `ssrVariants`, `appear`
  (elements with their initial inline style, `animations` JSON from `__framer__appearAnimationsContent`, animator
  script file), `handover` (CMS data), `cms.collections`, `components`, `imageHosts`, `scaleDownVariants`,
  `fontFamilies`, `fontHosts`, `modules`.
- **wordpress**: `version`, `theme[]`, `plugins{}`, `builders` (elementor: elements, kit, page id, template,
  per-post CSS, `entranceAnimations[]` from `data-settings._animation`, `motionEffects[]`, `sticky[]`, widgets,
  locations; divi; wpbakery; beaver; oxygen; bricks; gutenberg block counts), `restRoot`, `postId`, `bodyClasses`,
  `animationLibs` (AOS/WOW/GSAP/Swiper/Slick/Owl/Lottie… by asset names, `data-aos` counts), `modified`, `lazyImages`.

## assets.mjs — mirror every asset

```bash
node tools/migrate/assets.mjs [--verify] [--concurrency 6] [--max-mb 100] [--dry]
```

Collects `facts.assets`, every `@font-face` src and `url()`/`image-set()` of each stylesheet (following `@import`,
fetching missing imports into `css/`) and of inline styles; keeps same-site and `assetHosts` hosts; downloads to
`public/<mirrorPath(url)>` (`/_m/<host>/<path>__<queryhash>.<ext>`). Idempotent (existing files skipped, atomic
writes). Requests use the snapshot's browser user agent, a live-origin `Referer` and the Accept header Chromium
sends for that resource type (image Accept for images and extensionless URLs): CDNs serve AVIF/WebP by Accept, so
the mirrored bytes match what the live page displays.

`--verify` re-checks existing files (HEAD; ETag, else Content-Length, else Last-Modified, stored in
`assets-meta.json`; conditional GET when HEAD is refused) and re-downloads what changed — image optimizers
regenerate variants after the snapshot.

Outputs in `snapshots/<date>/`: `assets-map.json` `{url: mirrorPath}` (used by tojsx and gen-meta),
`assets-meta.json`, `assets-failed.json` (failures + unmirrored hosts), and `css-local/` — every stylesheet and
inline style rewritten (`url()` → mirror path, `@import` → relative local copy) so the project can import the
platform CSS verbatim (e.g. copy `css-local/` to `styles/platform/`). Unmirrored hosts are listed in the summary:
add them to `assetHosts` if they must be local (Typekit, a custom CDN), leave them otherwise (Turnstile, maps).

## gen-meta.mjs — exact head per route

```bash
node tools/migrate/gen-meta.mjs [--out lib/migrate/pages-meta.json]
```

Writes `{ "<route>": {...}, "__not_found__": {...} }` shaped like Next `Metadata`: `title`, `description`,
`keywords`, `robots`, `alternates {canonical, languages}`, `openGraph {title, description, url, siteName, type,
locale, images[{url,width,height,alt,type}], videos, audio, extra}`, `twitter {card, site, creator, title,
description, images}`, `icons {icon, apple, shortcut, other}`, `manifest`, `other` (remaining name/property metas;
platform markers such as `generator`, `ycode-*`, `framer-*`, `next-size-adjust` are dropped). Plus what Metadata
cannot express: `htmlLang`, `htmlDir`, `bodyClass`, `viewport`, `themeColor`, `jsonLd[]`, image `preloads[]`,
`status`, and `mirror {headAssetUrl: mirrorPath}`. Values are verbatim (entities decoded, URLs as on live).

```ts
import meta from "@/lib/migrate/pages-meta.json";
export function generateMetadata(): Metadata {
  const { htmlLang, htmlDir, bodyClass, viewport, themeColor, jsonLd, preloads, status, mirror, ...m } = meta["/about"];
  return { ...m, metadataBase: new URL("https://www.example.com") } as Metadata;
}
// Render jsonLd with <script type="application/ld+json"> and htmlLang/bodyClass in the layout.
```

## tojsx.mjs — section → TSX with the live markup

```bash
node tools/migrate/tojsx.mjs --page about --list
node tools/migrate/tojsx.mjs --page about --section 3 --name AboutHero --out app/about/_sections/hero.tsx
node tools/migrate/tojsx.mjs --page /about --range 0-4 --name AboutTop --out …
node tools/migrate/tojsx.mjs --page / --all --i18n --name HomePage --out …
  [--root "body > div.page-wrapper"] [--rendered] [--unlazy] [--keep-urls] [--json]
```

`--page`: slug, `/route` or a `.html` path. Source is `raw/<slug>.html` (pre-JS: initial animation states, all
Framer breakpoint variants); `--rendered` uses the rendered DOM (client-rendered content). Sections are the element
children of `rootSelector` (or `--root`); `script/noscript/link/meta/template` root children are skipped. When the
root has one wrapper child, `--list` prints the `--root` to use (Webflow `body > div.page-wrapper`, Elementor
`body > div.elementor`).

Conversion rules: `class`→`className`, `for`→`htmlFor`, style string → object cast `as CSSProperties` (custom
properties kept; duplicates → last wins; `!important` dropped with a warning), every `data-*`/`aria-*` kept, every
text node a JS string literal (never trimmed; NBSP, U+2028 and other invisible characters as `\u` escapes; whitespace
between inline elements kept; whitespace-only text inside table/tr/select dropped because React rejects it), void
elements self-closed, SVG attributes camelCased (`stroke-width`→`strokeWidth`, `xlink:href`→`xlinkHref`; `viewBox`
etc. come camelCased from the parser; `sodipodi:`/`inkscape:` metadata dropped), form state as uncontrolled defaults
(`defaultValue`, `defaultChecked`, `<select defaultValue>` from `selected` options, `<textarea defaultValue>`),
`<style>`/`<noscript>` via `dangerouslySetInnerHTML`, `<script>` and `on*` handlers removed and listed in the header
comment. Asset URLs in `src`, `srcset`, `poster`, `style url()`, lazy attributes (`data-src`, `data-srcset`,
`data-bg`, `data-video-urls`…) and svg `href` are rewritten through `assets-map.json` (mirrored hosts missing from
the map still get `mirrorPath()` and a warning). Same-site `<a href>` (absolute, root-relative or Framer's
`./page`) becomes `<Link>` from `next/link` with every attribute kept; `--i18n` wraps it as
`localizePath(locale, href)` after stripping any `config.locales` prefix (import paths: `config.i18n.configModule`,
`config.i18n.pathsModule`, default `@/lib/i18n/{config,paths}`). `--unlazy` promotes `data-src`/`data-srcset` to
`src`/`srcset` when `src` is a placeholder (WordPress lazy-load plugins).

Type safety (React 19 types, `tsc --strict`): numeric props become numbers (`tabIndex={-1}`, `colSpan={2}`,
`aria-level={2}`); props React types only on some elements (`htmlFor` on a `<span>`, `width` on a `<div>`), values
outside a typed union (`type="foo"` on a button, `aria-hidden="hidden"`, `hidden="until-found"`) and names JSX cannot
express (`@click`, `:class`, `data-a.b`) go through `{...({ "name": "value" } as object)}`; tags unknown to React's
types (`<font>`, custom elements) through `const Tag_x = "x" as ElementType`.

Report: `<outDir>/tojsx/<Name>.json` (images with mirror paths, internal links, removed scripts/handlers, forms,
unmapped assets, warnings: references to `#ids` defined outside the converted nodes such as Framer's svg templates,
`autoplay muted` videos (React does not serialize `muted` in SSR), `javascript:` hrefs blocked by React 19).

Exports for other tools: `resolvePage`, `loadDoc`, `rootOf`, `sectionsOf`, `convert`, `componentSource`, `jsStr`.

## head-check.mjs — live vs local head and HTTP

```bash
node tools/migrate/head-check.mjs [--routes /,/about,404] [--snapshot] [--same-host] [--concurrency 3] [--max 40]
```

Per route compares HTTP status, the redirect chain (`301 /about/`), html lang, title, description, robots,
viewport, canonical, hreflang, icons, JSON-LD types and every `og:*`/`twitter:*`. Prints only differences
(`key: live "…" | local "…"`); full report `<outDir>/head-check.json`. `--snapshot` takes the live side from the
snapshot facts (no live requests). `--same-host` maps the local origin to the live origin inside local values.
Metadata is read from the whole document, ignoring svg `<title>` (Next can stream metadata into `<body>`).

## Gotchas

- Convert from `raw/`, measure against live. The rendered DOM has animation END states (GSAP/IX2/appear inline
  styles), Swiper clones and lazy-load swaps; converting it freezes the page in its final state.
- Framer raw HTML contains every breakpoint variant (`.ssr-variant.hidden-<hash>`) and the CSS that hides them
  (`platformFacts.hiddenClasses`); keep both. Its svg icons may `<use href="#svg…">` templates outside `#main`.
- Webflow IX2 element targets are either `<pageId>|<w-id>` or a bare `data-w-id`; class targets apply site-wide.
  Newer sites also ship IX3 (`Webflow.require("ix3")…register([...],[...])`, GSAP timelines). Initial states are the
  server-rendered inline styles of `data-w-id` elements.
- Ycode interaction owners: walk the parsed RSC rows; never take "the last id before the key" in the text.
- React 19 SSR adds `<link rel="preload" as="image">` for non-lazy images (into `<head>` in Next): expected.
- Google Fonts CSS depends on the User-Agent; `css/` holds the Chromium version (woff2 + unicode-range).
- Elementor/AOS/WOW entrance animations need their CSS classes and a small observer; the facts list each one.
- Bot protection (Cloudflare challenge, 403/429/503) is reported, never bypassed: ask for an allowlist or an export.
- `--only` on a new day creates a partial snapshot that becomes the latest; run a full snapshot first or use
  `--date` to merge into an existing one.

## Repeated components (headers, footers, cards)

`tojsx` converts markup verbatim; repeated parts differ per page only in a few values. Parametrize after converting:

1. Convert the component from two or three pages (`--section 0 --name HeaderA` on each) and diff the files: what
   differs is the parameter list (Ycode: the `data-layer-id` prefix; Webflow: `w--current` and `aria-current`;
   Framer: variant classes; Elementor: `data-id`/`elementor-element-<id>`).
2. Keep one file and replace each varying literal with a prop, e.g. `data-layer-id={\`${layerPrefix}-x\`}`,
   `className={current === "/about" ? "nav-link w--current" : "nav-link"}`,
   `aria-current={current === "/about" ? "page" : undefined}`.
3. Generate the per-route values from the snapshot (`sections[]` in facts has the section `idAttribute` and classes
   for every page) into a JSON map `{route: {variant, layerPrefix}}` and let the layout pick them.
4. Group pages whose section class list is identical into the same variant; a different class list is a different
   variant, not a prop.
5. Re-run measure on every route that uses the component: a prop that changes classes changes layout.
