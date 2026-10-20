# migrate.config.json

Lives at the project root. Every tool reads it (`tools/migrate/lib/common.mjs`). Only `platform` and `live` are
required; the platform preset fills the rest.

```json
{
  "platform": "webflow",
  "live": "https://www.example.com",
  "local": "http://localhost:3100",
  "widths": [1920, 1440, 768, 390],
  "locales": ["en", "pt-br"],
  "routes": ["/landing-hidden-from-sitemap"],
  "excludeRoutes": ["/checkout", "/account"],
  "notFoundProbe": "/__migrate-404-probe",
  "rootSelector": "body",
  "idAttribute": "data-w-id",
  "assetHosts": ["assets.example-cdn.com"],
  "dynamicRegions": [
    { "route": "/work/*", "selector": ".related-projects", "reason": "randomized by the CMS on every publish" }
  ],
  "staticFlag": "__migrateStatic",
  "snapshotsDir": "snapshots",
  "outDir": "tools/out",
  "publicDir": "public",
  "mirrorPrefix": "/_m",
  "review": [
    { "route": "/", "label": "Home" },
    { "route": "/about", "label": "About", "note": "carousel moves with time" }
  ]
}
```

| Key | Meaning |
|---|---|
| `platform` | `ycode`, `webflow`, `framer`, `wordpress` or `other`. Selects the preset below. |
| `live` / `local` | Live origin and the local **production** server. Env `LIVE_URL` / `LOCAL_URL` override. |
| `widths` | Measured widths. Add 360, 1024, 1280, 2560 for the polish checks if needed. |
| `routes` / `excludeRoutes` | Extra routes not in the sitemap or crawl; routes to skip (account, checkout, search). Glob `*` allowed. |
| `rootSelector` | Container whose children are the page sections (Ycode `#ybody`, Framer `#main`, others `body`, Elementor pages often `.elementor` inside `main`). |
| `idAttribute` | Attribute that is stable between live and the conversion, used to pair elements section by section. When absent the tools pair by DOM path. |
| `assetHosts` | Extra hosts to mirror (CDNs). Same-origin is always mirrored. `*.host.com` wildcards. |
| `dynamicRegions` | Areas that change between loads on live (random related posts, counters, embeds). Masked in pixel diffs and excluded from pairing; content below is realigned. Always give a `reason`. |
| `staticFlag` | `window[staticFlag] = true` is set on the LOCAL side during measurement so motion you ADDED (polish layer, parallax) can switch itself off and the rest state compares with live. |
| `outDir` | Where measurements go. Env `MIGRATE_OUT` overrides it, so parallel agents use separate folders. |
| `mirrorPrefix` | Public path of mirrored assets: `https://cdn.x.com/a/b.png?w=8` → `/_m/cdn.x.com/a/b__<hash>.png`. |
| `review` | Pages shown on `/review` (default: main pages + one example per template + the home of each other locale + the 404). Per page: `route`, `label`, `note`, `liveRoute` (`null` = no live counterpart, e.g. `/privacy`), `compare: false` (show without %, e.g. a brand 404). |
| `stack` | Informational, filled from the intake: `{ "framework": "nextjs", "language": "typescript", "css": "tailwind", "cms": "payload", "database": "postgres" }`. The tools ignore it; agents and reviewers read it. Options in [stack.md](stack.md). |
| `defaultLocale` | Locale of unprefixed routes (used by `texts.mjs` language checks and the review page). |
| `reviewLang` | Language of the review page UI: `en`, `pt` or `es`. |
| `locales` | Locale prefixes found on live (e.g. `["en", "pt-br"]`). Drives `tojsx --i18n` and the language checks. |
| `i18n` | `{ "configModule": "@/lib/i18n/config", "pathsModule": "@/lib/i18n/paths" }`: where `tojsx --i18n` imports `localizePath` from. |
| `snapshot` | Pin a snapshot folder instead of the latest (env `MIGRATE_SNAPSHOT` also works). Useful when comparing an old snapshot. |
| `pixelTolerance` | Max differing-pixel ratio for `ok` (default `0.003` = 0.3%). |
| `seedRandom` | Seed `Math.random` identically on both sides during measurement (default `true`; sites that open a random slide otherwise produce hundreds of false divergences). |
| `phaseSelectors` | Extra selectors of carousel/marquee/ticker tracks whose horizontal phase is ignored (speed is compared instead). |
| `userAgent`, `browserLocale` | Override the headless browser's user agent and `Accept-Language` (some sites redirect by language). |

Presets (`lib/common.mjs`):

| platform | rootSelector | idAttribute | mirrored hosts (besides same-origin) |
|---|---|---|---|
| ycode | `#ybody` | `data-layer-id` | `*.supabase.co`, Google Fonts, cdnjs |
| webflow | `body` | `data-w-id` | `cdn.prod.website-files.com`, `*.website-files.com`, `uploads-ssl.webflow.com`, jQuery CDN, Google Fonts |
| framer | `#main` | `data-framer-name` | `framerusercontent.com`, Google Fonts |
| wordpress | `body` | `data-id` (Elementor) | `*.wp.com` (Jetpack CDN), Google Fonts |
| other | `body` | `id` | Google Fonts |
