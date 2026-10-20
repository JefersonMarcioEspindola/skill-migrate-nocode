# WordPress content → normalized format

Tools: `wp-inventory.mjs` (what is there) and `wp-export.mjs` (normalized `content/`). Both are zero-dependency
and never read or write credentials: `wp-config.php` is only scanned for `$table_prefix`; from `wp_options` only a
whitelist of option names is read; from `wp_users` only id / nicename / display name; `wp_usermeta`, comments,
form entries and WooCommerce orders are never exported.

## Decision tree

```
Do you have a SQL dump (mysqldump, phpMyAdmin, WP-CLI `wp db export`, backup plugin .sql)?
├─ yes → --dump (best: drafts, raw Gutenberg, every meta key, ACF/JetEngine definitions, menus, old slugs)
│        + --folder if you also have wp-content/ (plugin versions, uploads on disk, acf-json, table prefix)
└─ no
   ├─ hosting/SSH/admin access? → get a dump (`wp db export`, hosting panel, "All-in-One WP Migration" → .sql inside)
   └─ only the public site → --url (REST): published content only, rendered HTML, ACF only if show_in_rest
```

Always run the inventory first:

```bash
node wp-inventory.mjs --folder wp/ --dump backup.sql --url https://example.com --out content/_inventory
```

## Inputs

### (a) WordPress folder (`--folder`)

Root or `wp-content/`. Reports themes (`style.css` headers, parent theme, block theme, `acf-json/` groups), plugins
and versions (main file headers), mu-plugins, uploads size by year/extension, `.sql` files lying around, and the
table prefix. `wp-config.php` holds DB credentials and salts: never print it, copy it or commit it. Pass
`--uploads wp-content/uploads` to `wp-export.mjs` to fill `localFile` for attachments found on disk.

### (b) SQL dump (`--dump`)

Streamed, any size (373 MB / 200k posts: inventory 5 s, export 18 s). Handles extended inserts, escapes, `''`,
`0x…` / `_binary`, utf8mb4, conditional comments and `DELIMITER` blocks. `.sql.gz` must be decompressed first.
The table prefix is detected (`<prefix>posts` + `<prefix>options`), or pass `--prefix`. Multisite: sub-sites
use `wp_2_…` tables: run once per prefix.

### (c) REST API (`--url`)

`/wp-json/` (falls back to `?rest_route=/` and the `<link rel="https://api.w.org/">` header). Requests are spaced
(400 ms) and cached in `content/_raw/wordpress-rest/` (`--from-raw` replays offline). Pagination via `per_page=100`
+ `X-WP-TotalPages`; `--max-pages` caps it. Terms, media and authors are fetched by id (`include=`) for what the
exported items reference.

Limits: published content only; `content.rendered` is final HTML (shortcodes already expanded, no Gutenberg
comments); custom post types need `show_in_rest`; ACF values only when the field group has "Show in REST API"
(types are inferred); `/wp/v2/users` may be blocked (author references are dropped with a warning); menus,
templates, reusable blocks and navigation need auth. Plugins are detected from namespaces (`acf/v3`, `yoast/v1`,
`rankmath/v1`, `wc/v3`, `jetpack/v4`, …).

## What gets exported (dump)

- **Post types**: by default every non-internal type with rows (post, page, CPTs). `--types post,page,event` to choose.
  Revisions, attachments (→ assets), menus (→ `nav-menus`), ACF/Elementor/Jet internals and WooCommerce
  (`product`, `shop_order`… counted, out of scope) are not collections.
- **Core fields**: title, content (richtext), excerpt, featuredImage (`_thumbnail_id`), author (→ `users`),
  parent (hierarchical), menuOrder, template (`_wp_page_template`), pageBuilder, SEO, taxonomies (→ one
  collection per taxonomy: `category`, `post-tag`, custom), plus `--meta key1,key2` for plain custom fields.
- **Statuses**: publish → published; draft/pending/future → draft (+`sourceStatus`); private with
  `--include-private`; trash with `--include-trash` (`archived`); auto-draft and revisions never.
- **Dates**: `post_date_gmt` (UTC); when it is `0000-…`, the local `post_date` without timezone.
- **Rich text**: Gutenberg content keeps `<!-- wp:… -->` comments in `raw` only; reusable blocks
  (`<!-- wp:block {"ref":N} /-->`) are inlined into `html`; classic content goes through a `wpautop` equivalent;
  `[caption]` → `<figure>`, `[embed]` → link; other **shortcodes stay raw** and are listed in `_report.md`.
- **Assets**: attachment ids → `uploads` URL (`upload_url_path` or `siteurl/wp-content/uploads`, multisite
  `/sites/N/`), alt (`_wp_attachment_image_alt`), width/height/filesize (`_wp_attachment_metadata`). Inline images
  are matched back to attachments by URL (size suffixes `-1024x576` / `-scaled` ignored).
- **PHP serialized meta** is decoded (byte-accurate `s:N`, objects, double serialization). Lengths broken by a
  naive search-replace are repaired and counted in the report.

### ACF

Definitions come from `acf-field-group` / `acf-field` posts (settings are serialized in `post_content`, field key
in `post_name`, field name in `post_excerpt`, parent in `post_parent`), or from local JSON (`--acf-json
theme/acf-json`). Groups apply to a post type by location rule (`post_type == X`) or because its posts reference
the group's field keys (`_<name>` → `field_…` meta). Groups registered only in PHP (`acf_add_local_field_group`) have
no definition in the DB: the inventory reports "field keys used in postmeta have no definition" → export the
groups as JSON from ACF (Tools → Export) and pass `--acf-json`.

| ACF | normalized | storage decoded |
|---|---|---|
| text, textarea, email, time_picker | text | |
| url, oembed | link | |
| number, range | number | |
| wysiwyg | richtext (wpautop) | |
| image / file / gallery | image / file / image `multiple` | attachment id(s), gallery = serialized ids |
| select, radio, button_group, checkbox | option (`multiple` for checkbox/multi-select) | serialized arrays |
| true_false | boolean | `1`/`0` |
| link | link `{url, label, newTab}` | serialized `{title,url,target}` |
| post_object, page_link, relationship | reference / multi-reference (`to` = allowed post types) | id or serialized ids |
| taxonomy | (multi-)reference → taxonomy collection | term ids |
| user | reference → users | |
| date_picker / date_time_picker | date | `Ymd` / `Y-m-d H:i:s` (local time) |
| color_picker | color | |
| google_map | json (`structure: map`) | |
| repeater | json `structure: repeater`, `fields` | `name` = row count, rows in `name_<i>_<sub>` |
| group | json `structure: group` | `name_<sub>` |
| flexible_content | json `structure: flexible`, `layouts` | `name` = serialized layout names, rows in `name_<i>_<sub>`, row `{layout, …}` |
| clone | json (warning) | not expanded |
| password | **never exported** | |
| tab, message, accordion | skipped (UI only) | |

Any ACF/JetEngine field or `--meta` key whose name looks like a secret (`password`, `secret`, `token`, `api_key`…)
is also refused.

### JetEngine

- Meta boxes: option `jet_engine_meta_boxes` (serialized; `args.allowed_post_type`, `meta_fields[]`), plus
  `meta_fields` stored with each CPT in `<prefix>jet_post_types`.
- Types: text/textarea/iconpicker/time → text; wysiwyg → richtext; number; colorpicker → color; switcher →
  boolean (`"true"/"false"`); date / datetime-local (`is_timestamp` → epoch); checkbox → option `multiple`
  (serialized `{key: "true"|"false"}`); select/radio → option; media → image (`value_format` id / url / both);
  gallery → image `multiple` (comma ids or serialized); posts → (multi-)reference (`search_post_type`);
  repeater → json repeater (serialized `{item-0: {...}}`); html/tab/accordion/endpoint skipped.
- Post types / taxonomies: `<prefix>jet_post_types` (`status = publish`, `args` serialized with `rewrite_slug`),
  `<prefix>jet_taxonomies`.
- Relations: rows of `jet_post_types` with `status = relation` (`args.parent_object = posts::event`,
  `child_object`, `type`), data in `<prefix>jet_rel_default` (`rel_id, parent_object_id, child_object_id`) or a
  dedicated `<prefix>jet_rel_<id>` table. Exported as a (multi-)reference on the parent type.
- Custom Content Types (`<prefix>jet_cct_*` tables) are listed by the inventory, not exported (export them as CSV
  from JetEngine and normalize separately).

### CPT UI / ACF post types

`cptui_post_types` / `cptui_taxonomies` options (serialized arrays keyed by slug: `rewrite_slug`,
`rewrite_withfront`, `hierarchical`, `has_archive`, `taxonomies`, `object_types`) and ACF 6.1+ `acf-post-type` posts
give labels and permalink bases for old URLs.

### Page builders (noted, not converted)

| builder | detected by | exported |
|---|---|---|
| Elementor | `_elementor_data` (JSON) + `_elementor_edit_mode = builder` | `pageBuilder: "elementor"`; `--include-builder-data` adds the raw JSON as `builderData` |
| Beaver Builder / Bricks / Oxygen | `_fl_builder_data` / `_bricks_page_content_2` / `ct_builder_shortcodes` | `pageBuilder` |
| Divi / WPBakery | `[et_pb_section` / `[vc_row` shortcodes in content | `pageBuilder` + shortcode list |

Builder pages are layouts: rebuild them as components in stage 1 (visual) and keep only their text/data as content.
`post_content` of Elementor pages is a simplified HTML fallback, not the design.

### SEO

Yoast (`_yoast_wpseo_title`, `_metadesc`, `_canonical`, `_opengraph-image`, `_meta-robots-noindex`), Rank Math
(`rank_math_title`, `_description`, `_canonical_url`, `_facebook_image`, `rank_math_robots`), SEOPress
(`_seopress_titles_title`, `_desc`) → `seoTitle`, `seoDescription`, `seoCanonical`, `seoImage`, `seoNoindex`.
Template variables (`%%title%% %%sep%% %%sitename%%`) are left raw and reported: resolve them in the new SEO
component. Through REST, `yoast_head_json` gives already-resolved title/description. AIOSEO keeps data in
`<prefix>aioseo_posts` (inventory only).

### Menus, multilingual, redirects

- Menus: `nav_menu` terms + `nav_menu_item` posts (`_menu_item_type`, `_object`, `_object_id`, `_url`,
  `_menu_item_parent`) → collection `nav-menus` with a tree of `{label, url (old), newUrl, objectType, objectId, children}`.
- WPML (`<prefix>icl_translations`: `trid`, `language_code`, `source_language_code`) and Polylang (taxonomies
  `language` + `post_translations`, option `polylang.default_lang`) → `locale` on items; all translations share the
  id of the default-language post, the real post id goes to `sourceId`. Non-default locales are assumed to be
  served under `/<lang>/` on the old site.
- Redirect candidates: item permalinks rebuilt from `permalink_structure` (`%year% %monthnum% %day% %postname%
  %post_id% %category% %author%`, front base, page hierarchy, CPT rewrite slugs, home subdirectory), shortlinks
  `/?p=ID` and `/?page_id=ID` (query strings: match them in middleware or with `has` in `next.config`),
  `_wp_old_slug` history, category/tag/custom taxonomy archives (`category_base`, `tag_base`), date archives
  (`--routes archive=/blog`), author archives (`--routes author=/team/:slug`), `/feed` (`--routes feed=/rss.xml`)
  and the Redirection plugin table (`<prefix>redirection_items`, non-regex rules). Default new routes:
  `post=/blog/:slug`, `page=/:path`, `<cpt>=/<cpt>/:slug`, `category=/blog/category/:slug`, `post_tag=/blog/tag/:slug`.

## Out of scope

WooCommerce (products/orders/customers: counted only), comments, users beyond display names, form entries
(CF7/Flamingo/WPForms/Gravity), LMS/membership data, Elementor templates, theme options/customizer, widgets
(`sidebars_widgets`), JetEngine CCTs, ACF options pages (`options_*` rows in wp_options), and regex redirects.
Report them to the client as manual decisions.
