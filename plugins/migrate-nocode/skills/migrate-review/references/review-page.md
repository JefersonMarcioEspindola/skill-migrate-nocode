# The /review page

## Purpose

One page where the owner and the client SEE the migration: every page of the site in sequence, the current site and
the new one side by side, desktop and mobile, with the measured numbers under each capture. It replaces "trust me"
with evidence and is where the client says "this one is wrong". It is regenerated after every batch of fixes and
opened at the end of every migration.

## Format (the one owners approved; keep it simple)

- One page; anchors to every page at the top (a colored dot: green = matches, amber = to check, grey = no comparison);
  zoom sliders for desktop and mobile; a column filter (both / desktop / mobile).
- A header block: generation date, live URL and totals (pages, pages matching, divergences, average pixel % per width).
- One row per page, four columns: **Desktop current | Desktop new | Mobile current | Mobile new** (1440 and 390 by
  default, `--widths` to change). Full-page captures; click opens one at full size.
- Under each capture: width × document height; under the new one also the height delta, the % of differing pixels
  (masked ratio when measure masked GIFs/dynamic regions) and the number of divergences, amber when not ok.
- A short note per page with known differences that are not layout bugs (carousel phase, randomized blocks,
  deliberate deviations). Template collections show one example with "one of N pages".
- Pages without a live counterpart: brand 404 (`compare: false`) shows the live capture (the old plain 404) and no %;
  a new page (`liveRoute: null`, e.g. `/privacy`) shows "No live counterpart". Routes that answer 404 on live are
  left out.
- Light/dark follows the system; works on a phone (bar wraps, smaller default zoom); no external dependencies; lazy
  images; `noindex`.

## Generate

```bash
node tools/migrate/review/build-review.mjs --measure --open    # re-measure everything, rebuild, open
node tools/migrate/review/build-review.mjs --open              # rebuild from existing captures (measures only what is missing)
node tools/migrate/review/build-review.mjs --static review.html --open   # standalone file, no Next.js
  [--routes /,/about] [--widths 1440,390] [--lang en|pt|es] [--no-measure] [--max-height 48000] [--template file]
```

- Inputs: `<outDir>/<slug>/<width>/{live.png,local.png,report.json}` written by `measure.mjs`. `--measure` needs the
  local **production** server running (`LOCAL_URL`).
- Pages: `review.config.json` at the root (array, or `{ "pages": [...] }`), else `migrate.config.json → review`,
  else the main pages + one example per template (first path segment groups, or a `template`/`collection` field in
  the snapshot manifest) + the home of each other locale + the brand 404. Entry:
  `{ "route": "/about", "label": "About", "note": "…", "liveRoute": "/old-about" | null, "compare": false }`.
- Captures become WebP (quality 72) in `public/review-assets/<slug>/<width>/`; pages taller than 16 000 px are split
  into stacked tiles (WebP limit), capped at `--max-height`. Unchanged captures are not re-encoded; stale files are
  removed on full builds.
- Next.js: writes `app/review/review-html.ts`; installs `app/review/route.ts` from `assets/review-route.ts` when
  missing (static route, `X-Robots-Tag`, private `Cache-Control`). The skill copies `scripts/` to
  `tools/migrate/review/`; `review-template.html` and `review-route.ts` must sit next to `build-review.mjs` (or pass
  `--template`).
- It prints the URL (`<local>/review`) and always writes a fallback `<outDir>/review.html`. `--open` opens the local
  URL when that server already serves this build; otherwise (server down, or a production build older than this
  generation: `next start` needs a rebuild) it opens the fallback file and says why.
- UI language: `--lang` or `"reviewLang"` in the config (en default; pt, es). Notes are written as given.

## Protect

- Always out of the index: meta robots + `X-Robots-Tag` on the page, and on `/review-assets/*` via the proxy or
  `next.config` headers; `Disallow: /review` and `/review-assets/` for `*` and every AI crawler; out of the sitemap,
  never linked. See [../assets/robots-snippet.md](../assets/robots-snippet.md).
- Internal or preview domain: no password needed. Public domain: set `REVIEW_PASSWORD` in the host's environment and
  call `reviewGuard` from [../assets/review-auth.ts](../assets/review-auth.ts) first in `proxy.ts` (Next 16) or
  `middleware.ts`, with `/review` and `/review-assets/:path*` in the matcher. Basic Auth, any user name; invalid
  base64 or UTF-8 → 401; constant-time compare of SHA-256 digests. Tests: `assets/review-auth.test.ts` (vitest).
- Before the handoff ask the client: remove it (`app/review/`, `public/review-assets/`) or keep it protected.

## When to regenerate

After every batch of fixes (each phase that changes pages), after a re-sync with live, and always as the last step
of the migration: `build-review.mjs --measure --open`, then tell the user the URL. Numbers on the page must come
from a measurement of the current build, never from memory.
