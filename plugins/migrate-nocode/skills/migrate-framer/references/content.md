# Framer CMS content → normalized format

State of the options (checked Oct 2026):

| option | status | what you get | tool |
|---|---|---|---|
| **Server API** (`framer-api` npm package) | open beta since Feb 2026, free during the beta | typed fields, real item ids, drafts, arrays/galleries, localized values and slugs | `framer-api-dump.mjs` → `framer-csv-import.mjs --api-json` |
| **CMS Export plugin** (official, by Framer, open source) | stable, no plan restriction documented | one CSV per collection, default locale only, no galleries/arrays, no ids | `framer-csv-import.mjs <csv…>` |
| Community plugins (JSON Import & Export, CMS Forge…) | third party | JSON/CSV variants | normalize with `--schema` or convert to the CMS Export CSV shape |
| Scrape published pages | always possible | rendered text + images, no schema | stage-1 snapshot tools (fallback only) |

There is no built-in Export button in the CMS panel (only Import); Framer's help points to plugins.

## Path A — Server API (preferred)

Client side: open the project → **Site Settings → General → API Keys** → create a key. It acts as the user who
created it and is bound to that one project. Send it through a secret channel; revoke it after the migration.

```bash
npm i -D framer-api                       # Node >= 22; only for this step
export FRAMER_API_KEY=…                   # never commit it
node framer-api-dump.mjs --project "https://framer.com/projects/Site--aabbccdd1122" --out content/_raw/framer/framer-cms.json
node framer-csv-import.mjs --api-json content/_raw/framer/framer-cms.json --out content --old-routes "blog=/blog/:slug"
```

The dump calls `connect(projectUrl, key)`, `getDefaultLocale()`, `getLocales()`, `getCollections()`, and per collection
`getFields()` + `getItems()`, then `disconnect()`. It reads the **editor state** (unpublished edits and drafts
included), not the published site. The protocol is WebSocket based (not REST), which is why the dump is a
separate step that uses the official package, while the normalizer stays zero-dependency.

Shapes (framer-api 5.x typings): collection `{id, name, slugFieldName, managedBy}`; field `{id, name, type, required?,
cases?[{id,name}], collectionId?, fields?}`; item `{id, slug, slugByLocale, draft, createdAt?, updatedAt?, fieldData:
{[fieldId]: {type, value, valueByLocale?}}}`.

| Framer type | normalized | value |
|---|---|---|
| string | text | |
| formattedText | richtext | HTML (`rawFormat: framer-html`) |
| image | image | `{url, alt (altText), assetId}` (url = original size) |
| file | file | `{url, name, assetId}` |
| link | link | string (can be relative, `/features`) |
| date | date | ISO (UTC) |
| boolean, number | boolean, number | |
| color | color | string, or the linked color style's `light` value |
| enum | option | case id → `slugify(case name)`; options keep `sourceId` |
| collectionReference / multiCollectionReference | reference / multi-reference | item id(s) |
| array | json (repeater) — or `image` + `multiple` when it holds a single image field (gallery) | rows by sub-field |
| divider / unsupported | skipped | |

Localization: `getLocales()` excludes the default locale. Per-locale values live in `valueByLocale[localeId]`
(`status: new | needsReview | done | warning`; `null` value = fall back) for string/formattedText/link fields, and
`slugByLocale` on items. The normalizer emits a localized item only when a translated value or slug exists; URLs
get the locale `slug` prefix (`/pt/…`). Localized image alt text is only reachable through localization groups
(not exported).

No rate limits or plan restrictions are published for the beta; pricing is announced as per-use with a free
allowance. Calls are not transactional: rerun the dump if it fails midway.

## Path B — CMS Export plugin CSV

In the Framer editor: **Plugins → CMS Export** → pick the collection (defaults to the open one) → **Export**
(downloads `<Collection Name>.csv`; **Copy** puts it on the clipboard). Repeat per collection, then normalize all
files in one run so references by slug resolve:

```bash
node framer-csv-import.mjs exports/ --out content --old-routes "articles=/blog/:slug" --site https://www.example.com
```

Format (from the plugin source, `framer/plugins → plugins/cms-export/src/csv.ts`):

- Every cell quoted, `""` escapes, LF line ends, cells may contain newlines.
- Header = field display names. First column = slug (named after `slugFieldName`, default `Slug`).
- `:draft` column right after the slug only when at least one item is a draft (`true`/`false`).
- Image fields produce two columns: `<Name>` (URL `https://framerusercontent.com/images/<id>.<ext>`) and `<Name>:alt`.
- Rich text = HTML (`<p dir="auto">`, `<li data-preset-tag="p">`). Dates = ISO with milliseconds. Booleans `true/false`.
- Multi-references joined by `,` (no spaces). Enum and reference cells hold the raw stored value: case id / item id
  in the plugin code, names/slugs in some exports. The importer resolves slugs and warns when a column looks like
  9-character Framer ids (not resolvable from CSV → use the Server API or `--schema`).
- Not exported: arrays/galleries, localized values, item ids.
- Known plugin quirk: when an item has no value for a field, the cell is skipped, so later columns shift left. Rows
  whose cell count differs from the header are reported.

Without ids, the importer uses the **slug as item id**. If you later switch to the Server API dump, ids change
(upsert by slug in that case).

## Old URLs and the fallback

Framer CMS detail pages live wherever the designer put the collection page (`/blog/:slug` is common, not a rule).
Read the real paths from `/sitemap.xml` (localized sites: a sitemap index with `sitemap_<locale>.xml`) and pass
`--old-routes`. If the client gives neither API key nor CSVs, scrape the published detail pages listed in the sitemap
with the stage-1 snapshot tools: pages are server-rendered (rich text inside `data-framer-component-type="RichTextContainer"`,
images on `framerusercontent.com`), and `?md` or `Accept: text/markdown` returns Markdown for optimized pages. The
embedded `__framer__handoverData` and search index are undocumented and keyed by internal ids: last resort only.

## After the export

`content-validate.mjs content --check-assets`, then mirror `framerusercontent.com` assets (they stay public, but
the project owner can delete them).
