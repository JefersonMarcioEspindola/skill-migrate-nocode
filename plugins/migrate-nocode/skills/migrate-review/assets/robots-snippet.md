# Keeping /review out of search engines and AI crawlers

The review page shows full-page captures of the client's site before launch. It must never be indexed, cached by a
search engine or used for AI training. Use all four layers below: each one covers a gap of the others.

| Layer | What it stops | Where |
|---|---|---|
| `X-Robots-Tag: noindex, nofollow, noarchive, noimageindex` header | indexing of the page and of the WebP captures | `app/review/route.ts` (page) and the proxy / `next.config` (assets) |
| `<meta name="robots" content="noindex, nofollow, noarchive, noimageindex">` | indexing when the HTML is saved or proxied elsewhere | already in the template |
| `robots.txt` `Disallow: /review` and `/review-assets/` for `*` and every AI crawler by name | crawling by well-behaved bots, including AI training/answer bots | `app/robots.ts` |
| Out of the sitemap, never linked from the site | discovery | `app/sitemap.ts` |
| Optional Basic Auth (`REVIEW_PASSWORD`) | everyone without the password, including bots that ignore robots.txt | `proxy.ts` / `middleware.ts` + `assets/review-auth.ts` |

`Disallow` stops crawling, so a bot that obeys it never sees the `noindex`; a URL linked from somewhere else can then
still show up in results as a bare link. That is acceptable for a temporary page; when it is not, use the password.

## app/robots.ts

Named groups repeat the rules: a crawler that matches a specific group ignores the `*` group.

```ts
import type { MetadataRoute } from "next";

const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "anthropic-ai",
  "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "Amazonbot", "CCBot", "cohere-ai",
  "Meta-ExternalAgent", "Bytespider", "DuckAssistBot", "MistralAI-User",
];
// Keep the live site's own rules here as well (copy them from snapshots/<date>/robots.txt).
const ALLOW = ["/"];
const DISALLOW = ["/review", "/review-assets/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ALLOW, disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: ALLOW, disallow: DISALLOW },
    ],
    sitemap: "https://www.example.com/sitemap.xml",
  };
}
```

`Disallow: /review` is a prefix rule, so it also blocks `/reviews...`. If the site has real pages starting with
`/review` (a "reviews" section), don't rely on `$` anchors (not every bot supports them): move the review page to
another path instead, and change `app/review/`, `REVIEW_PATH` in `review-auth.ts` and these robots entries together.

## The captures (`/review-assets/*`)

The page sets its own header in `route.ts`; static files in `public/` need it from the proxy or `next.config`:

```ts
// next.config.ts (only if you have no proxy/middleware handling /review-assets)
async headers() {
  return [{ source: "/review-assets/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, noimageindex" }] }];
}
```

With `review-auth.ts` in the proxy (matcher includes `/review-assets/:path*`) the header and the password cover the
captures too.

## Sitemap

If `app/sitemap.ts` is generated from the route list, filter it:

```ts
const routes = allRoutes.filter((r) => !/^\/review(?:-assets)?(?:\/|$)/.test(r));
```

Never add `/review` to navigation, footer or `llms.txt`.

## Before the handoff

Ask the client: remove `/review` (delete `app/review/` and `public/review-assets/`) or keep it behind
`REVIEW_PASSWORD`. Don't print or commit the password; set it in the hosting provider's environment settings.
