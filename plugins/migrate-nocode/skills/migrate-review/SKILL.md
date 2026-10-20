---
name: migrate-review
description: Build and open the side-by-side /review page of a site migration — every page in sequence with Desktop current, Desktop new, Mobile current and Mobile new captures, plus height, pixel difference and divergence counts. Use at the end of every migration batch, whenever the user asks to see, review, compare or show the client the migrated site against the live one, or says "atualiza a página de review" / "update the review page".
---

# The /review page

The review page is how the owner and the client SEE the migration: one page, every page in sequence, current vs new
side by side, with the measured numbers under each capture. Always regenerate it after a batch of fixes and always
open it at the end of a migration.

## Format (the one owners approved)
- One page, all pages in sequence; anchors/shortcuts at the top; zoom control.
- One row per page, four columns: **Desktop current | Desktop new | Mobile current | Mobile new**.
- Under each capture: document height, % of differing pixels, number of divergences; a short note per page with
  known, non-layout differences (carousel phase, randomized blocks, deliberate deviations).
- Pages with no live counterpart (brand 404, `/privacy`) show the live capture if any and no percentage. Routes that
  404 on live are left out.
- Captures as static WebP files in `public/review-assets/`.

## Build and open

The `migrate` skill's setup copies `scripts/*`, `assets/review-template.html` and `assets/review-route.ts` into
`tools/migrate/review/`. If they're missing, copy them now.

```bash
node tools/migrate/review/build-review.mjs --measure --open        # re-measure, rebuild, open in the browser
node tools/migrate/review/build-review.mjs --static review.html    # standalone file, no Next.js needed
```

Pages come from `migrate.config.json → review` (default: main pages + one example per template). In a Next.js
project, copy `assets/review-route.ts` to `app/review/route.ts` (serves the generated HTML with
`X-Robots-Tag: noindex, nofollow`).

## Protection and SEO
- Always `noindex` (meta + `X-Robots-Tag`), out of the sitemap, and disallowed in `robots.txt` for search engines and
  AI crawlers ([assets/robots-snippet.md](assets/robots-snippet.md)).
- On an internal or preview domain no password is needed. If it's public, set `REVIEW_PASSWORD` and add the Basic
  Auth check from `assets/review-auth.ts` to the proxy/middleware. Copy `review-auth.test.ts` next to it too: it
  uses vitest (install it in the project, or skip the test file).
- Remove it (or keep it protected and unlinked) before the final handoff if the client prefers.

Details: [references/review-page.md](references/review-page.md).
