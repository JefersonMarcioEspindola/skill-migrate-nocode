# Ycode backup format (.ycode)

How to get it: in the Ycode builder, header menu → **Backup & Restore** → download (needs the "manage settings"
permission). File name: `<project-slug>-YYYY-MM-DD-HH-MM-SS.ycode`. The user may set an export password.

Source of truth: the open-source Ycode repo (`github.com/ycode/ycode`, `lib/services/projectService.ts`,
`types/index.ts`, `lib/collection-utils.ts`, `lib/localisation-utils.ts`, `lib/page-utils.ts`), checked against a
real 69 MB cloud backup (manifest 1.0.0, Oct 2026).

> **The backup contains secrets and personal data.** Treat it like a database dump: never commit it, never
> print values from the tables/keys listed under "Secret-bearing keys". `ycode-backup-inventory.mjs` and
> `ycode-export.mjs` only read the content tables.

## Container

| bytes | meaning |
|---|---|
| `1f 8b …` | gzip of a UTF-8 JSON document (the normal case) |
| `59 43 45 4e` ("YCEN") | password-protected: `"YCEN"` + salt (16) + IV (12) + GCM auth tag (16) + AES-256-GCM ciphertext of the gzip. Key = `scrypt(password, salt, 32)`. Pass the password through an env var: `--password-env YCODE_BACKUP_PASSWORD` |

The JSON is ~1.4× the file size (most of it is base64). Loading it whole in Node is fine for typical sites
(100 MB JSON → ~1 s). Do not `cat`/`head` it into an agent context.

```jsonc
{
  "manifest": { "version": "1.0.0", "exportedAt": "ISO", "source": "cloud" /* or "opensource" */, "projectName": "…",
                "tables": ["settings", "…"], "stats": { "pages": 22, "components": 14, "collections": 6, "assets": 164 },
                "lastMigration": "20260831000001_…" },
  "data":  { "<table>": [ /* rows */ ] },
  "files": [ { "storagePath": "<uuid>/<file>", "base64": "…", "mimeType": "image/webp" } ]
}
```

- `data` holds one array per table. Possible tables: settings, fonts, asset_folders, assets, page_folders, pages,
  page_layers, layer_styles, components, collections, collection_fields, collection_items, collection_item_values,
  collection_imports, locales, translations, versions, webhooks, webhook_deliveries, api_keys, app_settings,
  form_submissions, color_variables, global_variables, ai_chats. **Empty tables are omitted** (a single-language
  site has no `translations`; a site without folders has no `page_folders`).
- Columns `tenant_id`, `deleted_at`, `created_at`, `updated_at`, `content_hash` are stripped from every row;
  soft-deleted rows are excluded.
- `files[]`: binaries of the assets that have a `storage_path`, de-duplicated by path. Inline SVG assets have
  `storage_path: null` and the SVG markup in `assets.content`.

## Draft/published versions (important)

Most content tables have a composite key `(id, is_published)`: the same `id` appears once as draft
(`is_published: false`) and once as published (`true`). Pages, page_folders, page_layers, assets,
asset_folders, layer_styles, components, collections, collection_fields, collection_items,
collection_item_values, locales, translations, fonts, global_variables.

- An item with only a draft row was never published → export as `status: "draft"`.
- An item with both rows: the published row is what is live; the draft row may contain unpublished edits.
- `collection_items.is_publishable: false` = the editor set the item to "draft"; it will not publish.

## CMS tables

| table | columns (as seen) |
|---|---|
| `collections` | id, name, uuid, sorting (`{field: <field id>, direction}` or null), order, is_published |
| `collection_fields` | id, collection_id, reference_collection_id, name, key, type, default, fillable, order, hidden, data, is_published, is_computed |
| `collection_items` | id, collection_id, manual_order, is_published, is_publishable |
| `collection_item_values` | id, item_id, field_id, value (TEXT, nullable), is_published |

Built-in fields (non-null `key`): `id` (number, autoincrement display id), `status` (computed), `name`, `slug`,
`created_at`, `updated_at`. Custom fields have `key: null` and are matched by `field_id`.

Field `type` values and stored `value`:

| Ycode type | stored value | normalized type |
|---|---|---|
| `text`, `email`, `phone` | string | text |
| `number` | numeric string | number |
| `boolean` | `"true"`/`"false"` (also `"1"`, `"yes"`) | boolean |
| `date` | ISO date-time | date |
| `date_only` | `YYYY-MM-DD` | date |
| `color` | `#rrggbb` / `#rrggbbaa` | color |
| `reference` | target item uuid (`reference_collection_id` = target collection) | reference |
| `multi_reference` | JSON array string of item uuids | multi-reference |
| `rich_text` | Tiptap JSON doc, stringified | richtext (rawFormat `tiptap`) |
| `image`, `video`, `audio`, `document` | asset uuid; JSON array of uuids when `data.multiple: true` (galleries) | image / file |
| `link` | JSON `{type: "url"\|"page"\|"asset", url?, page?: {id, collection_item_id?, anchor_layer_id?}, asset?: {id}}` | link |
| `option` | option id from `data.options: [{id, name}]` | option |
| `count` | computed back-reference count | (skipped) |
| `status` | computed `{"is_publishable","is_published","is_modified"}` | (skipped → item.status) |

There is no per-item "published at" date: the exporter uses `created_at` as `publishedAt`.

### Rich text (Tiptap)

Nodes: `doc paragraph text heading bulletList orderedList listItem blockquote horizontalRule hardBreak table tableRow
tableCell tableHeader codeBlock image` plus Ycode's own `richTextImage` (attrs `src alt title width height assetId link`),
`richTextComponent` (embedded component, not convertible), `richTextHtmlEmbed` (attr `code`), `dynamicVariable`
(CMS binding, rendered as its label). Marks: `bold italic underline strike subscript superscript code dynamicStyle`
and `richTextLink` (attrs `type: url|email|phone|asset|page|field`, `url`/`email`/`phone` as
`{type: "dynamic_text", data: {content}}` or legacy `href`, `page: {id, collection_item_id}`, `asset: {id}`, `target`, `rel`).
Inline image `src` is either the Supabase public URL or a site-relative `/a/<id>/<name>-<suffix>.<ext>` — prefer
`assetId` → `assets.public_url`.

## Assets

`assets`: id, source (`file-manager`, `mcp`, `sample-collection`…), filename (often **without extension** — use
`mime_type`), storage_path, public_url (`https://<project>.supabase.co/storage/v1/object/public/assets/<uuid>/<file>`),
file_size, mime_type, width, height, content (inline SVG), is_published, asset_folder_id. `asset_folders`: id,
asset_folder_id (parent), name, depth, order. There is **no alt text** column: alt only exists on rich-text images.
Template sample assets (`source: "sample-collection"`) are usually not client content.

## Pages, folders, URLs

`pages`: id, page_folder_id, name, slug, order, depth, is_index, is_dynamic, error_page (401/404/500), settings
`{seo:{title, description, image, noindex}, auth:{enabled, password}, custom_code:{head, body}, cms:{collection_id, slug_field_id, next_previous}}`,
is_published, is_publishable. `page_folders`: id, page_folder_id, name, slug, depth, order, settings (auth).

- Static page URL = folder slugs + page slug; `is_index` pages map to the folder path (`/` for the root).
- Dynamic (CMS template) page: `is_dynamic: true`, `slug: "*"`, `settings.cms.collection_id`. Item URL = folder
  slugs + item slug (e.g. a root-level template gives `/<item-slug>`, inside folder `blog` gives `/blog/<item-slug>`).
- `page_layers` (id, page_id, layers[], generated_css) and `components` (layers[], variables[], variants[]) hold the
  visual tree — stage 1 (visual) material, not CMS.

## Localization

`locales`: id, code (`en`, `pt-br`…), label, is_default, is_published. `translations`: id, locale_id, source_type
(`page | folder | component | cms`), source_id, content_key, content_type (`text | richtext | asset_id | code`),
content_value, is_completed, is_published.

- CMS: `source_type: "cms"`, `source_id` = item id, `content_key` = `field:key:<builtin key>` (`field:key:name`,
  `field:key:slug`) or `field:id:<field id>`. Only `text` and `rich_text` fields are translatable.
- A translation applies only when `is_completed` and non-empty; otherwise the default-locale value is used.
- Default locale has no URL prefix; others: `/<code>/<translated folder slugs>/<translated slug>`.

## Secret-bearing keys (never print, never export)

| where | what |
|---|---|
| `settings` rows with key `ai_anthropic_api_key`, `ai_openai_api_key`, `ai_google_api_key`, `ai_xai_api_key` (also per-user `…:<userId>`) | AI provider API keys **in plain text** (seen populated in a real backup) |
| `settings.custom_code_head` / `custom_code_body`, `pages.settings.custom_code` | arbitrary scripts; may embed tracking ids or tokens |
| `settings.google_site_verification`, `ga_measurement_id` | site identifiers (not secret, but do not spread) |
| `app_settings` (app_id, key, value) | integration credentials: Airtable/Webflow `api_token`, GitHub `github_token`, maps keys |
| `webhooks.secret` | HMAC signing secrets |
| `api_keys` | key hashes + prefixes |
| `pages.settings.auth.password`, `page_folders.settings.auth.password` | page passwords in plain text |
| `form_submissions` (form_id, payload, metadata.page_url, status) | personal data from site forms |
| `ai_chats.messages`, `versions.undo/redo` | editor history; may contain any of the above |

Other `settings` keys seen (safe structure, values still not printed by the tools): `site_name`, `site_description`,
`timezone`, `ycode_version`, `published_at`, `published_css`, `draft_css`, `favicon_asset_id`, `web_clip_asset_id`,
`robots_txt`, `llms_txt`, `sitemap {mode, customXml, includeImages, defaultChangeFrequency}`, `global_canonical_url`,
`ycode_badge`, `color_variables_published_hash`.

## Real sample (redacted)

Cloud backup, 69 MB gzip → 99.8 MB JSON, 62 embedded files (96 MB of base64), 17 tables:
settings 20 · fonts 4 · asset_folders 4 · assets 164 rows (82 unique) · pages 22 (11 unique; 1 dynamic) ·
page_layers 22 · layer_styles 4 · components 14 (7 unique) · collections 6 (3 unique) · collection_fields 46 ·
collection_items 34 (18 unique: 16 published, 2 draft-only) · collection_item_values 222 · locales 2 (1 unique) ·
versions 460 · form_submissions 8 · color_variables 5 · ai_chats 1. Field types used: status, text, date, number,
image, rich_text, reference. Rich text used `paragraph heading bulletList listItem richTextImage` + `bold italic underline`.
One `ai_*_api_key` setting was populated — the client should rotate it.
