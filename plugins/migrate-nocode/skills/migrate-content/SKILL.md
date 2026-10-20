---
name: migrate-content
description: Second stage of a no-code site migration — pull the real CMS content (collections, posts, custom fields, media, SEO meta) from Ycode backups, the Webflow API/CSV, Framer CSV or WordPress (folder, .sql dump, REST, ACF, JetEngine), normalize it, and import it into the new project's CMS or content files without touching production data. Use after the visual migration is done, or whenever the user wants to move CMS collections, blog posts or custom fields off Ycode, Webflow, Framer or WordPress.
---

# CMS content stage

Runs after the visual stage, when pages already render the content as fixed JSON mocks. The job: replace the mocks
with real, editable content, keeping the same rendering (and therefore the same pixels).

## 1. Ask (once)
- Where will content live? Payload, Sanity, Contentful, Strapi, MDX/JSON files in the repo, or WordPress headless.
- Which collections are in scope (posts, case studies, team, jobs…), and which are out (shop orders, users, comments)?
- Locales and fallback rules.
- Where the source is: platform skill decides (Ycode `.ycode` backup, Webflow token or CSV, Framer CSV, WordPress
  folder / `.sql` / REST).
- Database for imports: a **dev branch or dev database** only. Never production. Confirm before any write.

## 2. Export to the normalized format
Copy the tools into the project if they aren't there yet (the visual stage already copied the core ones):

```bash
mkdir -p tools/migrate/platform tools/migrate/content
cp -R <platform skill dir>/scripts/* tools/migrate/platform/
cp -R <this skill dir>/scripts/* tools/migrate/content/
```

Use the platform skill's exporter (scripts copied to `tools/migrate/platform/`). Every exporter writes
`content/<collection>.json`, `content/_assets.json`, `content/_redirects.json` and `content/_report.md` in the format
described in [references/content-format.md](references/content-format.md). Then validate:

```bash
node tools/migrate/content/content-validate.mjs content/ --check-assets
```

Read `_report.md`: unknown field types, shortcodes, page-builder data, broken references. Resolve or record each.

## 3. Model and import
- Map each normalized collection to the target: [references/content-to-payload.md](references/content-to-payload.md)
  or [references/content-to-files.md](references/content-to-files.md).
- Seeds are **idempotent upserts keyed by the source id** (re-running never duplicates), and run against the dev
  branch/database. The user confirms before any database write.
- Media: download from `_assets.json` to object storage (or `public/` for small sites), keep alt texts, rewrite URLs.
- Rich text: keep sanitized HTML or convert to the CMS's format (Lexical, Portable Text, MDX), and keep the raw
  original in the record for audits.

## 4. Swap the mocks, re-measure
Replace `lib/data/*.json` reads with CMS queries, page by page, keeping the same markup and classes. Re-run the visual
checks (`run-all.mjs --sections`, `verify-dom.mjs`, `texts.mjs`): the content stage must not move a single pixel.

## 5. Redirects and SEO
Apply `_redirects.json` (301s for permalinks that changed), SEO titles/descriptions from the source (Yoast, Rank Math,
Webflow SEO fields), sitemap from the CMS, `Article` JSON-LD from real dates and authors.

## 6. Report
Counts per collection (source vs imported), skipped items and why, media moved, redirects, and what the client must
review (translations, legal texts, missing alts). Regenerate and open `/review` (skill `migrate-review`).
