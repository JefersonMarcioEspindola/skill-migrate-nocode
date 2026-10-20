# Stack: choose it before phase 0

Ask this at intake (question 2b) and record the answer in `docs/decisions/0000-intake.md` and in the `stack` key of
`migrate.config.json`. Don't change stacks halfway through: the board, the templates and the importer all depend on it.

The measuring half of the skill only needs a URL, so the **target can be any stack**. What is tied to React/Next.js is
the converter (`tojsx.mjs` writes TSX) and a few templates. Only the recommended stack has been used in real
migrations; say so when the user picks something else, and keep the same measurement loop.

## Present these options

**A. Recommended (default, field-tested)**

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript | Ycode already ships Next.js; `tojsx`, the review route and the metadata generator target it |
| Runtime | Node.js 20+ | The tools and the build run on it |
| CSS | Tailwind v4 (+ a small documented `legacy.css`) | See `tailwind-conversion.md` |
| CMS | Payload 3 (runs inside the same Next app) | Admin UI, typed collections, `content-to-payload.md` maps the normalized format |
| Database | PostgreSQL (Neon, Supabase or self-hosted) | What Payload uses; also holds form submissions |
| Media | Object storage (Vercel Blob or any S3-compatible) | `public/` can reach ~1 GB of mirrored assets |

**B. Next.js with another content source**: Sanity, Contentful, Strapi, or MDX/JSON files in the repo
(`content-to-files.md`). Same visual stage; only the content stage changes.

**C. Plain HTML, CSS and JavaScript**: the snapshot already is HTML, so the visual stage is the most direct. You still
need somewhere to keep data once there is content or a form: JSON/Markdown files for a small site, or a database
(PostgreSQL, SQLite, MySQL) when editors or forms are involved. Ask which.

**D. Other** (Python with Django/Flask, PHP/Laravel, Ruby, Astro, SvelteKit, Nuxt, Remix…): the user names it and the
skill checks it against the minimum below. If something on the list can't be met, say it before starting.

## Minimum contract for "Other"

The target must provide all of these, whatever it is built with:

1. **HTML**: every live route returns the page's HTML (server-rendered or static) with the same DOM structure, class
   names and `data-*`/`aria-*` attributes, because measurement pairs elements by them.
2. **CSS**: a way to ship the CSS each page needs. Baseline = the platform stylesheets as downloaded
   (`snapshots/<date>/css-local/`, `url()` already pointing at the mirror). If the target uses Tailwind, it needs a
   build step (Tailwind CLI or PostCSS work in any stack).
3. **JavaScript**: a way to ship client scripts with the exact library versions the live site uses (animation,
   slider, smooth scroll), vendored or bundled.
4. **Static assets** served at stable paths (`mirrorPrefix`, default `/_m/<host>/...`) with the same bytes.
5. **A local server in production mode** reachable at `local` in the config, answering the same routes with the same
   status codes and redirects. Measurement never runs against a hot-reload dev server.
6. **Metadata and plumbing**: `<head>` per route (title, description, canonical, OG, hreflang, JSON-LD), sitemap,
   robots, a branded 404, `lang` on `<html>`, locale routing.
7. **Data storage** for the content stage: a database or files, with migrations, secrets only in environment
   variables, and imports against a development database or branch, never production.
8. **Review page**: `build-review.mjs --static` writes a standalone HTML file that opens anywhere. Serving it at
   `/review` with `noindex` and the robots rules is the target's job.

Questions to ask when the user picks D: language and framework, template engine, how CSS is built, the command and
port to run it in production mode, where data will live. If the stack has no component model, convert from the raw
snapshot HTML (`snapshots/<date>/raw/<slug>.html`), rewriting asset URLs with `assets-map.json`; write a small script
for that, the way `tojsx` does it for TSX, and keep it in `tools/`.

## What works with which stack

| Tool | Any stack | Next.js / React only |
|---|---|---|
| `detect`, `snapshot`, `assets`, `head-check` (against a URL) | ✓ | |
| `measure`, `sections`, `states`, `motion`, `crop`, `run-all` | ✓ (need the local URL) | |
| `texts`, `intent-check`, `verify-dom` | ✓ | |
| `build-review --static`, `--open` | ✓ | |
| `tojsx` (writes TSX) | | ✓ (other stacks: script your own from the raw HTML) |
| `gen-meta` (writes `pages-meta.json` shaped like Next `Metadata`) | the JSON is reusable | the shape is Next's |
| `review-route.ts`, `review-auth.ts` | | ✓ (port to the target) |
| Content exporters and `content-validate` | ✓ (they write normalized JSON) | |
| `content-to-payload.md`, `content-to-files.md` | files mapping is generic | Payload mapping |

## Database in one line
The **visual stage never needs a database**: the site reads JSON. A database enters in the content stage (CMS
content, form submissions, auth). Recommended: PostgreSQL. Whatever the choice, imports run against a development
database and the user confirms before any write.
