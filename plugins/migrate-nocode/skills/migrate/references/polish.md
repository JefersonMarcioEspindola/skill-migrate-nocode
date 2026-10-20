# Optional polish layer (only if the user chose it at intake)

Some owners want the migrated site to be *better* than live, not only identical. Apply this only after fidelity is
closed and measured, in its own commits, each deviation written in `docs/decisions/`. The rest state keeps being
measured against live except for the recorded deviations; added motion switches off with `window[staticFlag]` and
with `prefers-reduced-motion`. When a taste request is ambiguous, show 2–3 visual options before implementing.

These came from a real owner's review after a faithful migration ("it felt weak"):

1. **Header contrast**: white text + `mix-blend-mode: difference`, grayscale, across the site; a fixed color picked
   from the image luminance only on full-bleed image heroes (list them explicitly). The fixed header must be a
   direct child of `body` with no ancestor using `transform`/`isolation`, or `difference` can't see the page.
   Check contrast scrolling every page, including white pages, and with the mobile menu open.
2. **Infinite marquee**: duplicate the set until it covers 2× 3840 px, speed by time (px/s, not per frame — it
   doubles at 120 Hz), no jump at the loop, slow down on hover. Test at 2560 and 3840.
3. **Line hover on every real link**, identical everywhere (the line draws in and leaves on the other side). Inventory
   by grep of `<a`, `<Link`, `underline`, `hover:`; no native underline left. Space links with `gap`, not padding,
   so the line sits under the right text. Things that aren't links must not look like links.
4. **Slow zoom on image cards** on hover (e.g. 5%, 900 ms, mouse only) and an optional light parallax.
5. **Language switch in the footer**, as text (EN / PT / …), never a native `<select>`, and not back in the header
   even if live or Figma has it there. A recorded owner decision beats fidelity.
6. `cursor: pointer` on everything clickable. Zero `href="#"`: every CTA points to a real route or goes to pending.
   Every social label is a real link (`target="_blank" rel="noopener"`).
7. **Brand 404** when live only has the platform default: the brand's display or script font, logo, links home /
   about / contact, all locales, status 404, `noindex`.
8. **Fix the live visual bugs** found in reconnaissance (mobile breakage, horizontal scroll, centering, state after
   resize), recorded as improvements.
9. **Mobile and tablet of pages Figma never designed**: review full-page captures (scroll first for lazy load) with a
   designer's eye, at 360, 390, 768, 945, 1024, 1280, in every locale (Portuguese/Italian strings are longer).
10. **Privacy & cookies** if the site has none: a `/privacy` page in every locale from a template marked as
    provisional for the client's legal review, a clean cookie banner (Accept/Decline on the right on desktop,
    pointer cursors), consent stored locally, analytics only after "accepted".
