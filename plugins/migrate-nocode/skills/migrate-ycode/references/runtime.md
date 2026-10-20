# Ycode runtime: interactions and sliders (semantics to reproduce)

Reverse-engineered from the published runtime chunks of a real Ycode site and verified against live in a headless
harness (Swiper classes, inline styles, active slide after 5 s, accordion states identical). Versions change: always
re-check the versions in the new site's chunks before reusing a port.

## Extracting interactions
Decode the RSC payload (`self.__next_f.push([1,"…"])`), split it into rows — `<id>:<json>\n` rows and
`<id>:T<hex>,<N bytes>` text rows that have **no trailing newline** (skip them by byte length) — parse JSON rows and
walk the tree. Every object that contains a non-empty `interactions` array is a TRIGGER layer; its `id` is the
`data-layer-id`. Fields like `"$2d:…"` are RSC references: resolve them to the referenced row. `snapshot.mjs`
implements this (`lib/platforms/ycode.mjs`).

Each interaction: `trigger` (`load`, `scroll-into-view`, `while-scrolling`, `click`, `hover`), `timeline`
(`repeat`, `yoyo`), `tweens[]` (`layer_id` target, `from`/`to` props, `duration`, `delay`/`position`, `ease`,
`splitText`, `stagger`), `breakpoints`, `apply_styles`, scroll `start`/`end`/`scrub`/`toggleActions`.

## Timeline semantics
- `gsap.timeline({ paused: true, repeat: timeline.repeat ?? 0, yoyo: timeline.yoyo ?? false })`, created lazily per
  interaction id.
- Per tween: `tl.set(target, from, position)`, then `fromTo` for keys present on both sides, `from` for from-only, `to`
  for to-only, chained with `"<"`. Position: numbers kept; `">"`/`"<"` only from the second tween; the first is at 0.
  `immediateRender` only when the position isn't relative. Minimum duration 0.001 s. `ease` passed straight to GSAP
  (`none`, `power1.in|out|inOut`, `back.in|out|inOut`…).
- Values: `autoAlpha` "0".."100" → 0..1; bare numbers get `px` (position/size) or `deg` (rotation/skew);
  blur/brightness/grayscale → `filter`; `display` leaves the props and becomes displayStart/displayEnd (`visible` by
  default). With `displayEnd: "visible"` the timeline `onStart` shows the element (removes `data-gsap-hidden` and
  stashes `hidden`/`max-md:hidden`/`max-lg:hidden`/`md:hidden`/`lg:hidden` classes in `data-gsap-stripped`); with yoyo,
  `onReverseComplete` restores; `displayEnd: "hidden"` hides at the end (`data-gsap-hidden=""`).

## Triggers
- **load**: plays once per active breakpoint.
- **scroll-into-view**: `ScrollTrigger.create({ trigger, start: scrollStart || "top 80%", toggleActions:
  toggleActions || "play none none none", animation })`; not recreated after entering.
- **while-scrolling**: `ScrollTrigger.create({ trigger, start: scrollStart || "top bottom", end: scrollEnd ||
  "bottom top", scrub: scrub ?? 1, animation })`.
- **click**: `repeat != 0` toggles pause/play; yoyo toggles play/reverse; otherwise `invalidate().restart()`.
- **hover**: `mouseenter` plays; `mouseleave` reverses only with yoyo. click/hover apply each target's `from` on mount.
- **Breakpoints**: mobile < 768, tablet 768–1023, desktop ≥ 1024, read from `window.innerWidth` (not
  `gsap.matchMedia`). No list = all. On breakpoint change: `clearProps: "all"` on targets, initial display re-applied,
  everything rebuilt (keeping open/closed state of click/hover valid on all breakpoints).
- A MutationObserver rebuilds (50 ms debounce) when nodes with triggers/targets enter the DOM, ignoring slider internals.

## Initial styles (server side)
`apply_styles[prop]` explicit wins; otherwise `load` and `scroll-into-view` are `on-load`, others `on-trigger`. The
server emits `<style id="ycode-gsap-initial-styles">` (opacity/visibility, transform, size, color, filter of `on-load`
props, with media queries when an interaction doesn't cover all breakpoints) and the list of layers born with
`data-gsap-hidden`. The converted page must carry that CSS, byte-identical to live.

## Sliders (`data-slider-settings` → Swiper)
Modules: Navigation, Pagination, Autoplay, Mousewheel + the effect module (`fade`, `cube`, `flip`, `coverflow`,
`cards`). `slidesPerView`: breakpoint `groupSlide` if > 1 else `"auto"`; `slidesPerGroup = min(slidesPerGroup,
groupSlide)`; responsive values inherit from the larger breakpoint; breakpoints at 768 and 1024. `centeredSlides`,
`speed = round(duration*1000)` (default 0.5 s), `loop: "loop"` → loop, `"rewind"` → rewind, `allowTouchMove:
touchEvents`, `slideToClickedSlide`, navigation `[data-slider-next]`/`[data-slider-prev]`, pagination
`[data-slider-pagination]` (bullets modeled on its first layer, `clickable`) or `[data-slider-fraction]`, autoplay
`{ delay: round(delay*1000) (default 3 s), disableOnInteraction: false, pauseOnMouseEnter: pauseOnHover ?? true }`,
mousewheel. After init: wrapper `transition-timing-function` (`ease-linear` → `linear`, default `ease-in-out`),
`aria-current` on the active bullet, `aria-disabled` on arrows, `data-slider-initialized=""`, `swiper.update()` on width
change. Unmount: `destroy(true, true)` and remove `data-slider-initialized` (StrictMode).

## Reduced motion (live ignores it; the migration shouldn't)
With `prefers-reduced-motion: reduce`: tweens get duration 0 (same triggers, order and display callbacks);
`while-scrolling` uses the same start/end with `toggleActions: "play none none reverse"` instead of scrub; rebuild on
preference change; no smooth scroll, marquees and autoplay carousels stay still.

## Reference implementation
A full TypeScript port with tests (interactions component, slider component, display helpers, swiper-minimal CSS
with hash test) exists from a previous migration; if you have access to it, reuse it after checking versions.
Otherwise port from the site's own chunks (`snapshots/<date>/` keeps their URLs) following the semantics above.
