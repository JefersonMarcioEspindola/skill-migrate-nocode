# Normalized content → files in the Next.js repo (JSON or MDX)

For small/medium sites without editors (or before a CMS is chosen), commit the content as files. Two layouts:

| layout | when | render |
|---|---|---|
| **JSON per collection** (keep `content/*.json` as is) | listings, data-heavy collections, rich text already HTML | `dangerouslySetInnerHTML` on the sanitized `html` |
| **MDX per item** (`content/<collection>/<slug>.mdx`) | blog/docs that humans will edit in git | `next-mdx-remote` / `@next/mdx` |

## JSON: read at build time

```ts
// lib/content.ts — server-only
import fs from 'node:fs'
import path from 'node:path'
import 'server-only'

const DIR = path.join(process.cwd(), 'content')
export type Item = { id: string; slug: string; locale?: string; status: 'published' | 'draft'; publishedAt?: string; url?: string; data: Record<string, any> }

const cache = new Map<string, Item[]>()
export function items(collection: string, { locale, drafts = false }: { locale?: string; drafts?: boolean } = {}) {
  if (!cache.has(collection)) {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, `${collection}.json`), 'utf8'))
    for (const f of c.itemFiles ?? []) c.items.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).items)
    cache.set(collection, c.items)
  }
  return cache.get(collection)!.filter((i) => (drafts || i.status === 'published') && (!locale || !i.locale || i.locale === locale))
}
export const bySlug = (collection: string, slug: string, locale?: string) => items(collection, { locale }).find((i) => i.slug === slug)
export const byId = (collection: string, id: string, locale?: string) => items(collection, { locale }).find((i) => i.id === id)
```

```tsx
// app/blog/[slug]/page.tsx
import { items, bySlug, byId } from '@/lib/content'
export const dynamicParams = false
export function generateStaticParams() { return items('blog-posts').map((i) => ({ slug: i.slug })) }
export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = bySlug('blog-posts', slug)!
  const category = post.data.category ? byId('blog-categories', post.data.category) : null
  return (<article><h1>{post.data.name}</h1>{category && <p>{category.data.name}</p>}
    <div className="prose" dangerouslySetInnerHTML={{ __html: post.data.content.html }} /></article>)
}
```

The `html` is sanitized by the exporter (allowlist, no scripts/handlers), so rendering it is safe. Keep it that way:
if editors change HTML by hand, re-run `content-validate.mjs` in CI (it fails on `<script>`, `on*=` and
`javascript:`). Exclude `content/_raw/` from the repo (`.gitignore`) — it can be large and is only for re-runs.

## MDX: one file per item

Convert once with a small script (`turndown` is the usual HTML → Markdown converter; keep it a dev dependency):

```js
// scripts/content-to-mdx.mjs — node scripts/content-to-mdx.mjs blog-posts
import fs from 'node:fs'
import path from 'node:path'
import TurndownService from 'turndown'
const [col] = process.argv.slice(2)
const c = JSON.parse(fs.readFileSync(`content/${col}.json`, 'utf8'))
for (const f of c.itemFiles ?? []) c.items.push(...JSON.parse(fs.readFileSync(`content/${f}`, 'utf8')).items)
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
td.keep(['iframe', 'video', 'figure', 'table'])                        // keep what Markdown cannot express
const rich = c.fields.find((f) => f.type === 'richtext')
for (const it of c.items) {
  const { [rich.name]: body, ...rest } = it.data
  const front = { id: it.id, slug: it.slug, status: it.status, publishedAt: it.publishedAt, locale: it.locale, oldUrl: it.url, ...rest }
  const yaml = Object.entries(front).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
  const dir = path.join('content', col, it.locale ?? '')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${it.slug}.mdx`), `---\n${yaml}\n---\n\n${body ? td.turndown(body.html) : ''}\n`)
}
```

Values in the front matter are JSON (valid YAML), so references stay ids and images stay `{url, alt}` objects.
MDX treats `{`, `}` and `<` specially: escape stray braces from the source text (`\{`), or render with
`format: 'md'` when the content has no components. WordPress shortcodes left in the text must be replaced by MDX
components (`[gallery ids="1,2"]` → `<Gallery ids={[1,2]} />`) or removed: see `_report.md`.

## Assets

`content/_assets.json` lists every URL. Download them into `public/` (or object storage) and rewrite URLs:

```js
// scripts/mirror-assets.mjs — downloads each asset once, writes content/_asset-map.json { oldUrl: "/media/…" }
import fs from 'node:fs'
import path from 'node:path'
const { assets } = JSON.parse(fs.readFileSync('content/_assets.json', 'utf8'))
const map = {}
for (const a of assets) {
  if (!a.url) continue
  const name = `${(a.sourceId ?? '').toString().slice(0, 12)}-${decodeURIComponent(new URL(a.url).pathname.split('/').pop())}`.replace(/[^\w.-]+/g, '_')
  const out = path.join('public/media', name)
  if (!fs.existsSync(out)) {
    const res = await fetch(a.url)
    if (!res.ok) { console.warn('skip', res.status, a.url); continue }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  }
  map[a.url] = `/media/${name}`
}
fs.writeFileSync('content/_asset-map.json', JSON.stringify(map, null, 2))
```

Then resolve URLs at render time (`map[url] ?? url`) or rewrite the JSON/MDX once. Use `next/image` with the
stored `width`/`height` when present.

## Redirects

Same as the Payload guide: load `content/_redirects.json` in `next.config.js` `redirects()` (skip `low`
confidence and query-string sources, which need `has` rules or middleware).

## Checklist

1. `node content-validate.mjs content --check-assets` → 0 errors.
2. Mirror assets, rewrite URLs, re-validate.
3. `next build` statically generates every slug (`dynamicParams = false` makes missing ones 404).
4. Spot-check pages against `item.url` on the old site.
