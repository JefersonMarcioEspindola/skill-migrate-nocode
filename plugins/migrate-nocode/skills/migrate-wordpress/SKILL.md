---
name: migrate-wordpress
description: WordPress-specific knowledge for migrating a WordPress site (Elementor, Divi, WPBakery, Gutenberg or a custom theme) to Next.js with pixel fidelity, and exporting its content — posts, pages, custom post types, ACF, JetEngine, CPT UI, Yoast/Rank Math SEO — from the install folder, a .sql dump or the REST API. Use with the `migrate` skill whenever the site is on WordPress (wp-content, wp-json, generator WordPress), the user mentions WordPress, Elementor, ACF, JetEngine, WooCommerce pages or "sair do WordPress".
---

# WordPress → Next.js

Follow the `migrate` skill for the method; this file holds what is specific to WordPress. WordPress is the most
varied platform: the theme and the page builder decide everything, so find them first.

## Markers and config
`/wp-content/`, `/wp-includes/`, `<link rel="https://api.w.org/">` (REST root `/wp-json/`), generator meta, body
classes (`page-id-12`, `single-post`, `elementor-page`). Config: `"platform": "wordpress"`; set `rootSelector` to
the content wrapper the theme uses (often `body`, or `#page`, `.site`, `main`; Elementor pages `.elementor` inside
`main`) after looking at the snapshot.

`snapshot.mjs` lists theme, plugins seen in asset URLs, builder, animation libraries and REST availability
(`facts → platform`).

## Builder by builder
- **Elementor**: stable ids `data-id` on sections/containers/widgets, classes `elementor-element-<id>`, global CSS
  (`elementor/css/global.css`, kit `post-<kitId>.css`) + per-page CSS `uploads/elementor/css/post-<id>.css` (or inline
  when "internal" CSS print method), `data-settings` JSON with entrance animations (`_animation`,
  `animation_delay`) and motion effects (scroll/mouse parallax, sticky), `elementor-invisible` + `animated <name>`
  classes from Animate.css. Swiper (Elementor's bundled version) for carousels.
- **Divi**: `et_pb_*` classes, CSS often inline/generated per page (`et-core-unified-*.css`), animations in
  `data-animation-*` and `et_animated` classes.
- **WPBakery**: `vc_row`, `vc_column`, `wpb_*` classes, `vc_custom_<id>` inline style rules.
- **Gutenberg / block themes**: `wp-block-*` classes, global styles `<style id="global-styles-inline-css">` with
  `--wp--preset--*` variables, `theme.json`-driven.
- **Custom themes**: the theme's `style.css` + enqueued assets; look for AOS/WOW/GSAP/ScrollMagic.

## CSS strategy
Copy every stylesheet the page loads, verbatim and in order (theme, builder, plugins, inline `<style>` blocks). Much of
it is unused — that's fine for fidelity. Only after a page measures clean, optionally prune with Chrome's CSS coverage
and **measure again**; record the decision. Breakpoints come from the theme/builder (Elementor defaults: tablet ≤ 1024,
mobile ≤ 767; custom breakpoints are in the kit settings CSS).

## JavaScript
jQuery-based plugins (Slick, Swiper, Owl, Magnific Popup, AOS, WOW): same library and version, same options (read them
from the inline init scripts or `data-*`). Port as client components with cleanup. Don't carry analytics, chat
widgets or cookie plugins blindly: list them in pending for the user to decide.

## Assets
Uploads under `/wp-content/uploads/YYYY/MM/name-WxH.ext` with `srcset`; Jetpack's `i0.wp.com` CDN; lazy-load plugins
swap `data-src`/`data-srcset` (the snapshot keeps the rendered DOM after scrolling, so real `src` values are there —
still check the converted JSX has real `src`, not placeholders).

## Forms
Contact Form 7, Gravity Forms, WPForms, Elementor Forms post to WordPress. Visual stage: same markup and states
(validation, success). Real handler later.

## Content (stage 2): pick the source
Decision tree, plugins (ACF, JetEngine, CPT UI, Meta Box, Pods), SEO meta, menus, multilingual, and what's out of
scope (WooCommerce orders, users, comments): [references/content.md](references/content.md).

```bash
node tools/migrate/platform/wp-inventory.mjs --folder legacy/wordpress --sql legacy/dump.sql   # or --rest https://site.com
node tools/migrate/platform/wp-export.mjs --sql legacy/dump.sql --types post,page,project --out content/
```

- **Install folder** copied into the project (e.g. `legacy/wordpress/`, git-ignored): themes, plugins and versions,
  uploads. `wp-config.php` holds database credentials and salts: never print, copy or commit it.
- **`.sql` dump**: the complete source (posts, meta, ACF/JetEngine definitions, options). Parsed by streaming.
- **REST API** (`/wp-json/wp/v2/…`): works without access, but only for post types with `show_in_rest`, and ACF only
  when exposed.
Then follow the `migrate-content` skill. Plan 301 redirects for permalinks (`/?p=ID`, categories, tags, date archives,
`/feed`).
