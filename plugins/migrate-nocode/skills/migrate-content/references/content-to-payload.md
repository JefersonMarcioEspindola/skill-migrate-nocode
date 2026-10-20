# Normalized content → Payload CMS (v3)

Goal: turn `content/*.json` into Payload collections and seed them **into a development database branch only**,
with idempotent upserts keyed by the source id, so the seed can run again after every re-export.

## 1. Map the schema

One Payload collection per normalized collection (skip `users` if the site has no author pages; skip
`nav-menus` if menus become code). Field mapping:

| normalized | Payload field | notes |
|---|---|---|
| text | `text` (or `textarea` when values contain newlines) | `titleField` → `admin.useAsTitle` |
| richtext | `richText` (Lexical) | convert `html` (section 4); keep `raw` out of Payload, it stays in `content/` |
| number | `number` | |
| boolean | `checkbox` | |
| date | `date` | date-only values: `admin.date.pickerAppearance: 'dayOnly'` |
| image / file | `upload` → `media` (`hasMany: true` when `multiple`) | upload first (section 3) |
| reference | `relationship` (`relationTo: '<to>'`) | `to` array → `relationTo: [...]` (polymorphic) |
| multi-reference | `relationship` + `hasMany: true` | |
| option | `select` (`options` from the field, `hasMany` when `multiple`) | values are already slugs |
| link | `text`, or a `group` `{url, label, newTab}` when the source had labels | |
| color | `text` (+ a color field component if wanted) | |
| json `structure: repeater` | `array` with the sub-fields mapped by the same table | |
| json `structure: group` | `group` | |
| json `structure: flexible` | `blocks` (one block per layout, `slug` = layout name) | rows carry `layout` → `blockType` |
| json (other) | `json` | |

Always add to every seeded collection:

```ts
{ name: 'slug', type: 'text', required: true, index: true, localized: hasLocales },
{ name: 'sourceId', type: 'text', required: true, unique: true, index: true, admin: { readOnly: true, position: 'sidebar' } },
{ name: 'sourceUrl', type: 'text', admin: { readOnly: true, position: 'sidebar' } },   // item.url (old path)
```

and `versions: { drafts: true }` when items have `status: draft`. Localized sites: enable `localization` in the
Payload config with the locale codes found in `items[].locale`; mark `text`/`richtext`/`slug` fields `localized`.
On `media`: `alt` (text), `sourceUrl` (text, unique, index).

## 2. Safety rules for the seed script

- **Never production.** The script refuses to run unless `SEED_DATABASE_URL` is set and differs from
  `DATABASE_URL`/`PRODUCTION_DATABASE_URL`, and `NODE_ENV !== 'production'`. Use a throwaway branch (Neon:
  `neon branches create --name seed/content`, then its connection string) or a local Postgres/SQLite.
- Dry run by default; writes only with `--yes`.
- Idempotent: every write is an upsert by `sourceId` (+ locale). Running twice changes nothing.
- No secrets in logs: print counts, never connection strings.
- Promote to production by migrating/restoring the reviewed branch, not by re-running the seed against it.

## 3. Seed script skeleton (`scripts/seed-content.ts`, run with `pnpm tsx`)

```ts
import fs from 'node:fs'
import path from 'node:path'
import { getPayload } from 'payload'
import { convertHTMLToLexical, editorConfigFactory } from '@payloadcms/richtext-lexical'
import { JSDOM } from 'jsdom'

const DIR = 'content'
const WRITE = process.argv.includes('--yes')
const seedUrl = process.env.SEED_DATABASE_URL
if (!seedUrl || process.env.NODE_ENV === 'production' || [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL].includes(seedUrl)) {
  console.error('Refusing to seed: set SEED_DATABASE_URL to a DEV branch (different from DATABASE_URL), NODE_ENV != production.')
  process.exit(1)
}
process.env.DATABASE_URL = seedUrl // payload.config reads DATABASE_URL
const { default: config } = await import('../payload.config')
const payload = await getPayload({ config })
const editorConfig = await editorConfigFactory.default({ config: payload.config })

// collections in dependency order: targets of references first (taxonomies, authors), then the rest
const read = (f: string) => {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  for (const part of c.itemFiles ?? []) c.items.push(...JSON.parse(fs.readFileSync(path.join(DIR, part), 'utf8')).items)
  return c
}
const cols = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !/\.items-\d+\.json$/.test(f)).map(read)
const assets = new Map(JSON.parse(fs.readFileSync(path.join(DIR, '_assets.json'), 'utf8')).assets.map((a: any) => [a.url, a]))

// --- media: upsert by sourceUrl (download once)
const mediaIds = new Map<string, string | number>()
async function media(url: string, alt?: string) {
  if (mediaIds.has(url)) return mediaIds.get(url)!
  const found = await payload.find({ collection: 'media', where: { sourceUrl: { equals: url } }, limit: 1, depth: 0 })
  if (found.docs[0]) { mediaIds.set(url, found.docs[0].id); return found.docs[0].id }
  if (!WRITE) return null
  const a: any = assets.get(url) ?? {}
  const data = a.localFile ? fs.readFileSync(a.localFile) : Buffer.from(await (await fetch(url)).arrayBuffer())
  const name = a.filename ?? decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file')
  const doc = await payload.create({ collection: 'media', data: { alt: alt ?? a.alt ?? '', sourceUrl: url }, file: { data, mimetype: a.mime ?? 'application/octet-stream', name, size: data.length } })
  mediaIds.set(url, doc.id)
  return doc.id
}

// --- rich text: upload inline images, then HTML -> Lexical (imgs without upload ids are DROPPED by the converter)
async function lexical(html: string) {
  const dom = new JSDOM(`<body>${html}</body>`)
  for (const img of [...dom.window.document.querySelectorAll('img')]) {
    const id = await media(img.getAttribute('src')!, img.getAttribute('alt') ?? '')
    if (id) { img.setAttribute('data-lexical-upload-id', String(id)); img.setAttribute('data-lexical-upload-relation-to', 'media') }
  }
  return convertHTMLToLexical({ editorConfig, html: dom.window.document.body.innerHTML, JSDOM })
}

// --- pass 1: upsert every item without relationships; pass 2: set relationships (all targets now exist)
const idMap = new Map<string, string | number>() // `${collection}:${sourceId}` -> payload id
for (const pass of [1, 2]) {
  for (const c of cols) {
    for (const it of c.items) {
      const data: any = { slug: it.slug, sourceId: it.id, sourceUrl: it.url, _status: it.status }
      for (const f of c.fields) {
        const v = it.data[f.name]
        if (v == null) continue
        const isRel = f.type === 'reference' || f.type === 'multi-reference'
        if ((pass === 1) === isRel) continue
        if (isRel) data[f.name] = [].concat(v).map((id: string) => idMap.get(`${f.to}:${id}`)).filter(Boolean)
        else if (f.type === 'richtext') data[f.name] = await lexical(v.html)
        else if (f.type === 'image' || f.type === 'file') data[f.name] = f.multiple ? (await Promise.all(v.map((x: any) => media(x.url, x.alt)))).filter(Boolean) : await media(v.url, v.alt)
        else data[f.name] = v
        if (f.type === 'reference') data[f.name] = data[f.name][0] ?? null
      }
      if (!WRITE) continue
      const where = { sourceId: { equals: it.id } }
      const existing = await payload.find({ collection: c.collection, where, limit: 1, depth: 0, draft: true, locale: it.locale })
      const doc = existing.docs[0]
        ? await payload.update({ collection: c.collection, id: existing.docs[0].id, data, locale: it.locale, draft: it.status === 'draft' })
        : await payload.create({ collection: c.collection, data, locale: it.locale, draft: it.status === 'draft' })
      idMap.set(`${c.collection}:${it.id}`, doc.id)
    }
    console.log(`${pass === 1 ? 'upserted' : 'linked'} ${c.collection}: ${c.items.length}`)
  }
}
console.log(WRITE ? 'done' : 'dry run (pass --yes to write)')
process.exit(0)
```

Adapt per project: field name mapping (e.g. `name` → `title`), repeaters/blocks (map `layout` → `blockType`),
default-locale-first ordering (`items` without `locale` or with the default locale first so `create` happens in the
default locale and other locales `update` the same document), and `publishedAt`.

## 4. Rich text notes

- `convertHTMLToLexical` (Payload 3, needs `jsdom`) drops `<img>` without `data-lexical-upload-id` +
  `data-lexical-upload-relation-to`: upload first (as above).
- Unsupported HTML (iframes, tables without the table feature, `<figure>` captions) is flattened: enable the
  Lexical features you need (`EXPERIMENTAL_TableFeature`, a custom embed block) or keep those items' HTML in a
  `code`/`json` field and render it with `dangerouslySetInnerHTML` (the HTML is already sanitized).
- Shortcodes and builder content listed in `_report.md` need manual decisions before seeding.

## 5. Redirects

Copy reviewed entries from `content/_redirects.json` into `next.config.js`:

```js
async redirects() {
  const { redirects } = require('./content/_redirects.json')
  return redirects.filter((r) => !r.from.includes('?') && r.confidence !== 'low')
    .map((r) => ({ source: r.from, destination: r.to, permanent: r.status !== 302 }))
}
```

Query-string sources (`/?p=123`) need a `has: [{ type: 'query', key: 'p', value: '123' }]` rule or middleware.

## 6. Checklist

1. `node content-validate.mjs content` → 0 errors.
2. Create the dev branch, set `SEED_DATABASE_URL`, run the seed dry, then `--yes`.
3. Run it again: counts unchanged (idempotent).
4. Compare item counts per status/locale with `_report.md`; open 3 items per collection in the admin.
5. Visual check of detail pages against `item.url` on the old site (stage-1 tools).
