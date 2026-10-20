# Definition of done and exceptions

Per page and per width (1920, 1440, 768, 390), measured against the PRODUCTION build:

| Check | Tool | Pass |
|---|---|---|
| Element divergences | `measure.mjs` | 0 (vertical offset explained by a recorded exception is allowed) |
| Section properties | `sections.mjs` | 0 divergent properties |
| Document height | `measure.mjs` | equal, or the delta attributed to a recorded exception |
| Pixels | `measure.mjs` | < ~0.3% differing (raw and masked reported) |
| Texts, alts, head | `texts.mjs`, `head-check.mjs` | no differences |
| Template DOM | `verify-dom.mjs` | clean on every route of each collection |
| Intent | `intent-check.mjs` | no horizontal scroll, no text under the fixed header, no clipped boxes, no `href="#"`, pointer cursors |
| States | `states.mjs` | hover, focus, menu open/close, accordions, form states equal |
| Motion | `motion.mjs` | start/end equal; timing and curve within sampling error |

## Declared exceptions (record each in docs/pendencias.md with the reason and the numbers)
- Image/video compression and CDN re-encoding (pixel noise with no visual effect).
- Animated GIFs (frame depends on load time) — masked.
- Randomized or time-based blocks (related posts reshuffled on each publish/ISR, relative dates, counters) — listed
  in `dynamicRegions`.
- Carousels and marquees: phase depends on start time; compare SPEED instead (px/s), measured equal.
- Content exceptions decided with the user (a page that intentionally differs, a fixed live bug).
- Polish-layer deviations (only if the user chose it), each in `docs/decisions/`.

Anything else that differs is a bug in the migration, not an exception.
