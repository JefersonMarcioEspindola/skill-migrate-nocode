---
name: migrate-ycode
description: Ycode-specific knowledge for migrating a site published on Ycode to Next.js with pixel fidelity, and for exporting its CMS from a .ycode backup. Use together with the `migrate` skill whenever the site runs on Ycode (HTML has #ybody, data-layer-id, /a/<id>/ assets, ycode-styles), the user mentions Ycode, a .ycode backup file, or "sair do Ycode".
---

# Ycode → Next.js

Ycode publishes **Next.js + Tailwind v4**. That makes it the easiest platform to migrate faithfully: the HTML already
carries the exact classes, so conversion is literally copying classes into JSX. Follow the `migrate` skill for the
method; this file holds what is specific to Ycode. Proven on a 107-route bilingual site (424 measurements at 0
divergent properties).

## Markers and config

`#ybody` (root, `display: contents`), `data-layer-id` on every layer, `<style id="ycode-styles">`, assets under
`/a/<id>/<name>?width=&quality=`, fonts often as OTF on `*.supabase.co`, payload in `self.__next_f.push`.
Config: `"platform": "ycode"` (preset: rootSelector `#ybody`, idAttribute `data-layer-id`).

## CSS and foundations
- **Tailwind v4 at the SAME version** that generated `ycode-styles` (e.g. 4.1.18), default theme, native
  breakpoints, `source(none)` + `@source` only for `app/` and `components/`. Classes live in TSX (Tailwind doesn't
  scan `lib/`).
- Ycode's own CSS goes **outside layers, verbatim, in HTML order**: runtime (slider, icons, select), head custom
  code, form reset, color variables `--<uuid>` (from the `ycode-color-vars` style), fonts, and the GSAP initial
  states `<style id="ycode-gsap-initial-styles">`. Outside layers they beat utilities, as on live.
- Ycode's global `.font-sans` (`var(--font-inter, ui-sans-serif…)`) wins over Tailwind's `--font-sans`; replicate it
  in the utilities layer or you get ~13 divergences per page.
- `data-gsap-hidden="mobile|tablet|desktop"` hides layers per breakpoint (`display:none !important`). Keep it.
- Body classes per page (e.g. `font-sans bg-white` on most, an extra font class on Home).
- `#ybody` is `display: contents`: Next can't scroll to top on navigation → `scrollTo(0,0)` + smooth-scroll immediate
  reset on every pathname change, close the menu on link click.

## Runtime: interactions and sliders
Ycode ships two client components only on pages that need them: **interactions** (GSAP + ScrollTrigger + SplitText
embedded, e.g. 3.14.2) and **sliders** (Swiper, e.g. 12.1.2, identified by code fingerprint, with Ycode's own
`/swiper-minimal.css`, never the package CSS). Custom code may load another GSAP from cdnjs (e.g. 3.12.5): keep both
(`gsap` + alias `gsap-runtime: npm:gsap@<runtime version>`).

The extraction and the exact trigger semantics are in [references/runtime.md](references/runtime.md). The key fact:
the **trigger of an interaction is the layer object that CONTAINS the `interactions` key** in the RSC payload (its
`id` is the `data-layer-id`). Extracting "the last id before the key" picks the wrong layer (a `<p>` instead of the
section; an icon's HTML id instead of the accordion row). `snapshot.mjs` does it right and saves it in
`facts/<slug>.json → platform.interactions`.

## Custom code
Lenis, menus, marquees, cursor trails and alt fallbacks come in the payload as custom code; some scripts live inside
HTML embeds in the RSC rows (e.g. relative "posted N days ago" dates). Port each as a client component, verbatim
logic, with unmount cleanup. A hero pre-init that must run before hydration goes into the server HTML only.

## Things that change under you
- The image optimizer regenerates variants after your snapshot (1,664 changed once) → `assets.mjs --verify`.
- "Related"/"More articles" blocks are re-randomized on every ISR regeneration, even without a publish →
  `dynamicRegions`.
- Routes start redirecting (307/308) when the client unpublishes pages mid-migration → re-sync in phase 9.
- The Supabase font host can time out → the measure tool serves mirrored fonts to the live side.
- The default 404 is a bare "404 / Page not found" with an empty body in the snapshot → brand 404 if the user wants.

## CMS structure (phase 1) and content (stage 2)
Source: the `.ycode` backup (Ycode → Settings → Backups → download). It never drives the visual (the live HTML does),
but the **inventory** in phase 1 shows collections, fields, dynamic pages and item counts, which is what you need to
shape the JSON mocks and templates. The export is stage 2. Inventory and export:

```bash
node tools/migrate/platform/ycode-backup-inventory.mjs path/to/site.ycode
node tools/migrate/platform/ycode-export.mjs path/to/site.ycode --out content/
```

The backup can contain API keys and secrets: the scripts never print values; never paste its content in chat.
Format notes: [references/backup-format.md](references/backup-format.md). Then follow the `migrate-content` skill.
