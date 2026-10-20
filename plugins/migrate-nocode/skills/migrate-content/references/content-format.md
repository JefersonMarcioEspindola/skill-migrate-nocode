# Normalized content format (formatVersion 1)

Every platform exporter in this plugin (Ycode backup, Webflow API/CSV, Framer CSV, WordPress dump/REST)
writes the same format into a `content/` folder at the project root. Importers (Payload seed, MDX/JSON
files, Sanity…) only ever read this format, never the platform's raw data.

```
content/
  <collection>.json      one file per collection (blog posts, authors, categories, pages, CPTs…)
  _assets.json           every media URL referenced by any item (with alt/size/dimensions when known)
  _redirects.json        old URL → new URL candidates
  _report.md             what the last export did: counts, unknown field types, warnings
  _raw/<platform>/…      optional: raw API responses kept for offline re-normalization (never secrets)
  _files/…               optional: binary files extracted from a backup (Ycode --extract-files)
  _inventory/…           optional: inventory outputs (ycode-backup-inventory, wp-inventory)
```

Files whose name starts with `_` are not collections. `content-validate.mjs` checks everything below.

## `<collection>.json`

```jsonc
{
  "formatVersion": 1,
  "collection": "blog-posts",            // file name without .json; lowercase kebab-case, unique
  "label": "Blog posts",                 // original display name
  "titleField": "name",                  // data key that holds the item's display title (optional)
  "source": {
    "platform": "ycode",                 // ycode | webflow | framer | wordpress
    "ref": "c4b0…",                      // platform id of the collection (collection id, post type slug, CSV file name…)
    "exportedAt": "2026-10-19T12:00:00.000Z",
    "tool": "ycode-export.mjs"
  },
  "fields": [ /* Field */ ],
  "items":  [ /* Item */ ]
}
```

Large collections (more than 2000 items by default) keep `"items": []` and add `"itemCount": 12345` and
`"itemFiles": ["post.items-0001.json", …]`; each part is `{ "collection", "part", "items": [] }`. This keeps every
file small enough for `JSON.parse`. Read collections with `readCollection()` from `content-common.mjs`, which
merges the parts.

### Field

```jsonc
{
  "name": "coverImage",       // REQUIRED. data key. /^[A-Za-z_][A-Za-z0-9_]*$/, camelCase, unique in the collection
  "label": "Cover image",     // original display label
  "type": "image",            // REQUIRED. one of the types below
  "required": false,          // true when the source marks it required
  "multiple": false,          // image | file | option: value is an array
  "options": [{ "value": "red", "label": "Red", "sourceId": "opt_1" }],   // option only; sourceId = platform option id
  "to": "blog-categories",    // reference | multi-reference: target collection (string, or array when polymorphic)
  "fields": [ /* Field */ ],  // json only: sub-schema of a repeater/group (same Field shape, recursive)
  "layouts": [{ "name": "hero", "label": "Hero", "fields": [] }],  // json + structure "flexible" only
  "structure": "repeater",    // json only: repeater | group | flexible | map | builder | unknown
  "inferred": false,          // true when the type was guessed from values (CSV, REST without schema)
  "source": { "key": "cover-image", "type": "Image", "id": "64f…" }  // original key/type/id (free-form)
}
```

| type | value in `item.data[name]` |
|---|---|
| `text` | string (plain text, may contain newlines) |
| `richtext` | `{ "html": "<p>…</p>", "raw": <original value>, "rawFormat": "html" }` — see Rich text |
| `number` | number |
| `boolean` | boolean |
| `date` | ISO 8601 string. Date-only values stay `YYYY-MM-DD`; date-times are UTC `…Z` when the timezone is known |
| `image` | `{ "url": "https://…", "alt"?, "width"?, "height"?, "assetId"? }`; an array of these when `multiple`. `url` may be `null` only when `localFile` is set (e.g. Ycode inline SVGs) |
| `file` | `{ "url": "https://…", "name"?, "mime"?, "size"?, "assetId"? }`; an array when `multiple` |
| `reference` | string: the target item's `id` (source id, not slug) |
| `multi-reference` | string[]: target item ids, in source order |
| `option` | string: one of `options[].value`; string[] when `multiple` |
| `link` | string URL, or `{ "url", "label"?, "newTab"? }` when the source stores a label/target |
| `color` | string as stored (`#rrggbb`, `rgba()`, CSS variable…) |
| `json` | any JSON value. Repeaters: array of row objects keyed by sub-field `name`; groups: object; flexible: array of `{ "layout": "<name>", …fields }` |

A missing key or `null` means "no value". Empty strings from the source are converted to `null`
(except for `text`, where they are kept as `""` only when the source distinguishes them).

Unknown source field types are exported as `json` with `source.type` set to the original type and listed
under "Unknown field types" in `_report.md`. UI-only fields (ACF tab/message/accordion, JetEngine
tab/html/endpoint) are not exported.

### Item

```jsonc
{
  "id": "6512…",               // REQUIRED. stable source id (string). Same id across locales of one item
  "sourceId": "9",             // optional. original platform id when `id` is a translation-group id (WPML/Polylang)
  "slug": "my-first-post",     // REQUIRED. unique per (collection, locale)
  "locale": "pt-br",           // optional. absent = default/only locale
  "status": "published",       // REQUIRED. published | draft
  "sourceStatus": "future",    // optional. original status when it carried more meaning (WP private/future/pending, Webflow archived)
  "archived": false,           // optional. Webflow isArchived, WP trash
  "publishedAt": "2026-08-31T17:04:48.753Z",  // optional
  "createdAt":   "2026-08-31T17:04:48.753Z",  // optional
  "updatedAt":   "2026-08-31T17:16:10.193Z",  // optional
  "url": "/blog/my-first-post",  // optional. public path on the OLD site (used for redirects and visual checks)
  "data": { "name": "My first post", "coverImage": { "url": "…" }, "category": "6513…" }
}
```

- `data` keys must be declared in `fields`. Order of `items` = source order (manual order when the platform has one).
- Localized content: one item per (id, locale). Non-localized fields repeat the same value in every locale.
- References always point to ids; slugs are resolved by the exporter (CSV sources reference by slug).
- CSV sources without item ids (Framer CMS Export) use the slug as `id`.
- `url` paths keep the old site's structure (including a subdirectory such as `/news` for WordPress in a folder),
  without the trailing slash: Next.js strips trailing slashes before `redirects()` run.

## Rich text

```jsonc
{
  "html": "<h2>Title</h2><p>Text with <a href=\"https://x.com\">link</a></p>",
  "raw": { "type": "doc", "content": [] },  // original value, untouched: Tiptap JSON, Gutenberg HTML with <!-- wp: --> comments, Webflow HTML…
  "rawFormat": "tiptap"                     // html | tiptap | gutenberg | classic | webflow-html | framer-html
}
```

`html` is sanitized by an allowlist (`sanitizeHtml` in `content-common.mjs`):

- Kept tags: `p h1–h6 a strong b em i u s del ins sup sub small mark code pre kbd br hr blockquote q cite
  ul ol li dl dt dd figure figcaption img picture source video audio iframe table thead tbody tfoot tr th td
  caption span div`.
- Kept attributes: `a[href title target rel]`, `img[src alt title width height srcset sizes loading]`,
  `source[src srcset type media]`, `video/audio[src controls poster loop muted playsinline]`,
  `iframe[src title width height allow allowfullscreen]` (only https embeds from YouTube, Vimeo, Loom,
  Spotify, Google Maps, Wistia, Vidyard, Twitter/X, Instagram, TikTok, CodePen, Figma; other iframes are
  dropped and reported), `th/td[colspan rowspan scope]`, `ol[start reversed type]`, `code/pre[class=language-*]`,
  `[id]`, `[dir]`, `[lang]`. Everything else (`style`, `class`, `on*`, `data-*`) is removed.
- Removed with content: `script style noscript template object embed form input button select textarea`.
  Other unknown tags are unwrapped (children kept). HTML comments are removed (Gutenberg block comments
  survive only in `raw`). `javascript:`/`vbscript:`/`data:` (except `data:image/*` in `img`) URLs are dropped.
- Output is balanced (unclosed tags are closed).
- WordPress shortcodes (`[gallery ids="…"]`) are kept verbatim as text and listed in `_report.md`.

## `_assets.json`

```jsonc
{
  "formatVersion": 1,
  "assets": [
    {
      "url": "https://cdn.example.com/a/cover.webp",  // absolute URL on the old platform (null only when localFile is set)
      "sourceId": "cb26…",       // platform asset/attachment id, when known
      "filename": "cover.webp",
      "mime": "image/webp",
      "size": 123456,            // bytes
      "width": 1600, "height": 900,
      "alt": "Alt text",
      "localFile": "content/_files/cb26…/cover.webp",   // when the binary was extracted from a backup
      "usedBy": [{ "collection": "blog-posts", "item": "6512…", "field": "coverImage", "inline": false }],
      "unused": false            // true for library assets referenced by no exported item (inventory info)
    }
  ]
}
```

Assets are deduplicated by `url` (or `sourceId` when there is no URL). Rich-text inline images are listed with
`"inline": true`. Exporters never download assets; the importer (or a mirror script) does, using this list.

## `_redirects.json`

```jsonc
{
  "formatVersion": 1,
  "redirects": [
    { "from": "/?p=123", "to": "/blog/my-first-post", "status": 301, "reason": "wp shortlink",
      "collection": "post", "item": "123", "confidence": "high" }
  ]
}
```

- `from` is a path (or path + query) on the old host; `to` is a path on the new site computed from the
  route templates passed with `--routes` (e.g. `--routes "post=/blog/:slug,category=/blog/category/:slug"`;
  tokens: `:slug`, `:id`, `:locale`, `:path` for hierarchical pages, `:yyyy/:mm/:dd`).
- Entries where `from === to` are not written (the item's old URL is still in `item.url`).
- `confidence`: `high` (direct item URL), `medium` (archive/taxonomy page), `low` (date archives, feeds, guesses).
- These are candidates: review them, then copy into `next.config.js` `redirects()` or middleware.

## `_report.md`

Written by every exporter, overwritten on each run: tool + timestamp, per-collection counts (items by
status/locale, fields by type), unknown field types, unresolved references, missing assets, rich-text
sanitization removals, shortcodes/page-builder data found, and anything the importer must decide by hand.

## Rules for exporters

1. Never print or write tokens, passwords, API keys, DB credentials, salts, form submissions or user emails.
   Inventories show key names and counts only.
2. Terminal output stays short (a summary line per collection); details go to `_report.md`.
3. Exports are deterministic: same input → same files (except `exportedAt`), so diffs are reviewable.
4. Ids are the source platform ids, so imports can upsert idempotently by `(collection, id, locale)`.
