// WordPress (themes, plugins and page builders: Elementor, Divi, WPBakery, Beaver, Oxygen, Bricks, Gutenberg).
import { elements, attr, classList, cleanUrl } from "../capture.mjs";

export const name = "wordpress";

export function evidence(html, url, headers = {}) {
  const ev = [];
  const gen = html.match(/<meta[^>]+name="generator"[^>]+content="(WordPress[^"]*)"/i)?.[1];
  if (gen) ev.push({ what: `generator meta "${gen}"`, weight: 3 });
  if (/rel=["']https:\/\/api\.w\.org\/["']/.test(html)) ev.push({ what: "REST API link (api.w.org)", weight: 3 });
  const wc = (html.match(/\/wp-content\//g) || []).length;
  if (wc) ev.push({ what: `/wp-content/ refs x${wc}`, weight: 2 });
  if (/\/wp-includes\//.test(html)) ev.push({ what: "/wp-includes/ refs", weight: 2 });
  if (/class="[^"]*\bwp-block-/.test(html)) ev.push({ what: "wp-block-* classes", weight: 1 });
  if (/api\.w\.org/.test(headers.link || "")) ev.push({ what: "Link header api.w.org", weight: 3 });
  if (/wordpress|wp engine|kinsta|wpengine/i.test(headers["x-powered-by"] || "")) ev.push({ what: `x-powered-by: ${headers["x-powered-by"]}`, weight: 1 });
  void url;
  return ev;
}

export const detect = (html, url, headers) => evidence(html, url, headers).reduce((a, e) => a + e.weight, 0) >= 3;

const ANIM_LIBS = [["aos", /\/aos(?:\.min)?\.js|aos@/i], ["wow", /\/wow(?:\.min)?\.js/i], ["gsap", /gsap/i], ["ScrollTrigger", /ScrollTrigger/i], ["swiper", /swiper/i],
  ["slick", /slick/i], ["owl", /owl\.carousel/i], ["lottie", /lottie/i], ["lenis", /lenis/i], ["locomotive", /locomotive/i], ["rellax", /rellax/i],
  ["isotope", /isotope/i], ["magnific", /magnific/i], ["fancybox", /fancybox/i], ["animate.css", /animate(?:\.min)?\.css|e-animations|animations\.min\.css/i], ["waypoints", /waypoints/i]];

function settingsOf(n) {
  const raw = attr(n, "data-settings");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { _raw: raw.slice(0, 300) }; }
}

export function facts(rawHtml, renderedHtml, ctx) {
  const doc = ctx.rawDoc;
  const els = elements(doc);
  const body = els.find((n) => n.tagName === "body");
  const bodyClasses = classList(body);
  const urls = [...new Set([...ctx.stylesheets.map((s) => s.href), ...ctx.scriptUrls, ...[...rawHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => cleanUrl(m[1]))])];

  const themes = {};
  const plugins = {};
  for (const u of urls) {
    const t = u.match(/\/wp-content\/themes\/([^/?#]+)/)?.[1];
    if (t) themes[t] = (themes[t] || 0) + 1;
    const p = u.match(/\/wp-content\/plugins\/([^/?#]+)/)?.[1];
    if (p) plugins[p] = (plugins[p] || 0) + 1;
  }
  const generators = [...rawHtml.matchAll(/<meta[^>]+name="generator"[^>]+content="([^"]+)"/gi)].map((m) => m[1]);
  const cls = (re) => els.filter((n) => classList(n).some((c) => re.test(c))).length;

  const builders = {};
  // Elementor: every element has data-id + elementor-element-<id>; data-settings holds motion effects/entrance animations.
  const elEls = els.filter((n) => attr(n, "data-element_type") || classList(n).some((c) => /^elementor-element-[0-9a-f]+$/.test(c)));
  if (elEls.length || plugins.elementor || generators.some((g) => /elementor/i.test(g))) {
    const animated = [];
    const motion = [];
    const sticky = [];
    const widgets = {};
    for (const n of elEls) {
      const s = settingsOf(n);
      const id = attr(n, "data-id");
      const w = attr(n, "data-widget_type");
      if (w) widgets[w] = (widgets[w] || 0) + 1;
      if (!s) continue;
      const anim = s._animation || s.animation;
      if (anim && anim !== "none") animated.push({ id, type: attr(n, "data-element_type"), animation: anim, delay: s._animation_delay ?? s.animation_delay ?? null, tablet: s._animation_tablet || null, mobile: s._animation_mobile || null });
      const mfx = Object.keys(s).filter((k) => /^motion_fx|^background_motion_fx/.test(k));
      if (mfx.length) motion.push({ id, settings: Object.fromEntries(mfx.map((k) => [k, s[k]])) });
      if (s.sticky) sticky.push({ id, sticky: s.sticky, on: s.sticky_on || null, offset: s.sticky_offset ?? null });
    }
    const postCss = [...new Set(urls.map((u) => u.match(/uploads\/elementor\/css\/(post-\d+\.css)/)?.[1]).filter(Boolean))];
    builders.elementor = {
      version: generators.find((g) => /elementor/i.test(g)) || null,
      elements: elEls.length,
      kit: bodyClasses.find((c) => /^elementor-kit-\d+$/.test(c)) || null,
      pageId: bodyClasses.find((c) => /^elementor-page-\d+$/.test(c)) || null,
      template: bodyClasses.find((c) => /^elementor-template-/.test(c)) || null,
      postCss,
      entranceAnimations: animated,
      motionEffects: motion,
      sticky,
      widgets,
      locations: els.filter((n) => attr(n, "data-elementor-type")).map((n) => ({ type: attr(n, "data-elementor-type"), id: attr(n, "data-elementor-id"), location: attr(n, "data-elementor-post-type") || null })),
    };
  }
  const divi = cls(/^et_pb_/);
  if (divi || themes.Divi || plugins["divi-builder"]) builders.divi = { modules: divi, animated: cls(/^et_animated$/) };
  const vc = cls(/^(vc_row|wpb_)/);
  if (vc || plugins.js_composer) builders.wpbakery = { elements: vc, animated: cls(/^wpb_animate_when_almost_visible$/) };
  const fl = cls(/^fl-(row|module|builder)/);
  if (fl || plugins["beaver-builder-lite-version"] || plugins["bb-plugin"]) builders.beaver = { elements: fl };
  const ct = cls(/^ct-(section|div-block|text-block)/);
  if (ct || plugins.oxygen) builders.oxygen = { elements: ct };
  const brx = cls(/^brxe-/);
  if (brx || themes.bricks) builders.bricks = { elements: brx };
  const blocks = {};
  for (const n of els) for (const c of classList(n)) { const m = c.match(/^wp-block-([a-z0-9-]+?)(?:__|$)/); if (m) blocks[m[1]] = (blocks[m[1]] || 0) + 1; }
  if (Object.keys(blocks).length) builders.gutenberg = { blocks };

  const libs = {};
  for (const [k, re] of ANIM_LIBS) { const hits = urls.filter((u) => re.test(u.split("?")[0])); if (hits.length) libs[k] = hits.slice(0, 3); }
  const aosEls = els.filter((n) => attr(n, "data-aos")).length;
  if (aosEls) libs.aosElements = aosEls;
  const wowEls = cls(/^wow$/);
  if (wowEls) libs.wowElements = wowEls;

  const restRoot = els.find((n) => n.tagName === "link" && attr(n, "rel") === "https://api.w.org/")?.attrs.find((a) => a.name === "href")?.value || null;
  return {
    generators,
    version: generators.find((g) => /^WordPress/i.test(g))?.replace(/^WordPress\s*/i, "") || null,
    theme: Object.keys(themes).sort((a, b) => themes[b] - themes[a]),
    plugins,
    builders,
    restRoot,
    postId: bodyClasses.find((c) => /^(page-id|postid)-\d+$/.test(c)) || null,
    bodyClasses,
    animationLibs: libs,
    modified: rawHtml.match(/property="article:modified_time"\s+content="([^"]+)"/)?.[1] || null,
    lazyImages: els.filter((n) => n.tagName === "img" && (attr(n, "data-src") || attr(n, "data-lazy-src") || attr(n, "data-srcset"))).length,
  };
}

export const summarize = (f) => `theme ${f.theme[0] || "?"}, builders ${Object.keys(f.builders).join("+") || "none"}${f.builders.elementor ? ` (elementor elements ${f.builders.elementor.elements}, entrance anims ${f.builders.elementor.entranceAnimations.length}, motion fx ${f.builders.elementor.motionEffects.length})` : ""}, plugins ${Object.keys(f.plugins).length}`;
