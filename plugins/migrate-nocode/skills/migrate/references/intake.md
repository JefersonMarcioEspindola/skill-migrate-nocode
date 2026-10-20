# Intake: the questions, their defaults, and why they matter

Ask everything in ONE message, after running `detect.mjs`. Offer the default for each question so the user can
answer "defaults" and go. Never ask again later what is answered here; the only later questions are the single
reconnaissance list (end of phase 1), client decisions, credentials, database writes and deploy/push.

| # | Question | Default | Why it matters |
|---|---|---|---|
| 1 | Live URL, and is the detected platform right? | detected | Picks the platform skill (CSS strategy, ids, animation data, content export). |
| 2 | Project folder or repository? Existing template, or a fresh Next.js + TypeScript (App Router)? | fresh scaffold in a new folder | The tools are copied into this project. A team template may bring its own rules (AGENTS.md): follow them unless they conflict with fidelity. |
| 3 | Scope now: visual only, or visual + CMS content? | visual only | Fidelity first, with CMS lists as fixed JSON; content migration is a separate stage with different risks (data, database). |
| 4 | Which languages, and how are they routed on live (`/en`, `/pt-br`, subdomain, none)? Are mirrors translated? | as found by the snapshot | Routes, `lang`, hreflang, dictionaries. Live mirrors are often untranslated copies. |
| 5 | Figma links? | none | Desktop design values, favicon, share image, and redesigned components not yet published. Figma is often out of date OR ahead of live; text always comes from live. |
| 6 | Platform export available? Ycode `.ycode` backup / Webflow API token (read-only) or CSV export / Framer CSV export / WordPress folder, `.sql` dump or open REST API | none yet | Only used in the content stage. Never needed for the visual. Tokens go in `.env.local`, never in chat. |
| 7 | Where will CMS content live later? (Payload, Sanity, Contentful, MDX/JSON files, keep WordPress headless…) | decide at the content stage | Shapes the normalized export and the importer. |
| 8 | After fidelity, apply the optional polish layer, or stay 100% faithful? | faithful | Some owners want the live site improved (header contrast, hover lines, infinite marquee, brand 404). It is recorded as deliberate deviations. See polish.md. |
| 9 | Git: work on `main` or a branch? | branch `migration/visual` unless the user prefers main | Some teams commit straight to main; respect it. Push and deploy only when asked. |
| 10 | Is the review page public or behind a password? | no password on an internal/preview domain; `REVIEW_PASSWORD` if public | The review page is always `noindex`, out of the sitemap, blocked in robots. |
| 11 | Anything known to be wrong on live? (outdated texts, unpublished changes in the builder, broken links) | none | Clients sometimes edit in the builder and never publish, then publish mid-migration. Plan a re-sync at the end anyway. |

## Platform-specific follow-ups (only if relevant)

- **Ycode**: do you have the `.ycode` backup (Settings → Backups)? Any custom code in the project settings?
- **Webflow**: which plan (CSV export and API access depend on it)? Localization enabled? Memberships/Ecommerce
  (out of scope, record)? Forms that must keep working (needs a form backend later)?
- **Framer**: CMS collections in use? Any code components or overrides? Localization?
- **WordPress**: builder (Elementor, Divi, WPBakery, Gutenberg, custom theme)? Custom fields (ACF, JetEngine, Meta Box,
  Pods)? Custom post types (CPT UI, JetEngine)? SEO plugin (Yoast, Rank Math)? Multilingual (WPML, Polylang)?
  WooCommerce (out of scope for a site migration, record)? Can you copy the install folder or a `.sql` dump into the
  project (a folder like `legacy/wordpress/`, git-ignored)?

## After the answers

Write `migrate.config.json`, record the answers in `docs/decisions/0000-intake.md`, and start phase 0 without
asking for confirmation.
