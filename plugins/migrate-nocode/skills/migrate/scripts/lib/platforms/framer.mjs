// Framer. The raw (SSR) HTML holds every breakpoint variant (.ssr-variant + .hidden-<hash> classes hidden by media
// queries); hydration later removes the variants that do not match the viewport, so the rendered DOM only has one.
// Appear animations: elements with data-framer-appear-id start from an inline style and are animated by the inline
// "animator" script using the JSON in <script type="framer/appear" id="__framer__appearAnimationsContent">.
import { elements, attr, classList, textOf, fontFaces, mediaQueries, breakpointWidths, sha1 } from "../capture.mjs";

export const name = "framer";

export function evidence(html, url, headers = {}) {
  const ev = [];
  const gen = html.match(/<meta[^>]+name="generator"[^>]+content="(Framer[^"]*)"/i)?.[1];
  if (gen) ev.push({ what: `generator meta "${gen}"`, weight: 3 });
  if (/data-framer-hydrate-v2/.test(html)) ev.push({ what: "data-framer-hydrate-v2 root", weight: 3 });
  const names = (html.match(/data-framer-name=/g) || []).length;
  if (names) ev.push({ what: `data-framer-name x${names}`, weight: 2 });
  const cdn = (html.match(/framerusercontent\.com/g) || []).length;
  if (cdn) ev.push({ what: `framerusercontent.com refs x${cdn}`, weight: 1 });
  if (/data-framer-css-ssr/.test(html)) ev.push({ what: "style[data-framer-css-ssr]", weight: 2 });
  if (/framer\.(website|app|ai|photos|media)\b/.test(url || "")) ev.push({ what: "framer hosting domain", weight: 1 });
  if (/framer/i.test(headers.server || "")) ev.push({ what: `server: ${headers.server}`, weight: 2 });
  return ev;
}

export const detect = (html, url, headers) => evidence(html, url, headers).reduce((a, e) => a + e.weight, 0) >= 3;

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

export function facts(rawHtml, renderedHtml, ctx) {
  const doc = ctx.rawDoc;
  const els = elements(doc);
  const main = els.find((n) => attr(n, "id") === "main");
  const hydrate = json(attr(main, "data-framer-hydrate-v2") || "");
  const styles = els.filter((n) => n.tagName === "style");
  const scripts = els.filter((n) => n.tagName === "script");

  // SSR CSS (all component styles) and the breakpoint CSS that hides non-matching variants.
  const ssrEls = styles.filter((n) => n.attrs.some((a) => a.name.startsWith("data-framer-css-ssr")));
  const ssrCss = ssrEls.map(textOf).join("\n");
  const bpEl = styles.find((n) => n.attrs.some((a) => a.name === "data-framer-breakpoint-css"));
  const bpCss = (bpEl ? textOf(bpEl) : "") + "\n" + ssrCss;
  const hiddenClasses = {};
  for (const m of bpCss.matchAll(/@media\s*([^{]+)\{\s*((?:\.hidden-[\w-]+\s*,?\s*)+)\{\s*display\s*:\s*none\s*!important;?\s*\}\s*\}/g))
    for (const c of m[2].split(",").map((x) => x.trim().slice(1)).filter(Boolean)) hiddenClasses[c] = m[1].trim();

  const appearEls = els.filter((n) => attr(n, "data-framer-appear-id")).map((n) => ({ appearId: attr(n, "data-framer-appear-id"), name: attr(n, "data-framer-name") || null, tag: n.tagName, style: attr(n, "style") || null }));
  const scriptById = (id) => scripts.find((n) => attr(n, "id") === id);
  const appearContent = scriptById("__framer__appearAnimationsContent");
  const appearBps = scriptById("__framer__breakpoints");
  const appearData = appearContent ? json(textOf(appearContent)) : null;
  const animatorScript = scripts.find((n) => /var animator=|__framer_appear|framer-appear-start/.test(textOf(n)));
  const handover = scripts.find((n) => attr(n, "type") === "framer/handover");
  const handoverText = handover ? textOf(handover) : "";

  const save = (kind, text, ext) => (text ? ctx.save(`platform/framer-${kind}-${sha1(text)}.${ext}`, text) : null);

  // Images and fonts.
  const imageHosts = {};
  for (const m of rawHtml.matchAll(/https?:\/\/([a-z0-9.-]+)\/images\/[^"'\s)&]+/gi)) imageHosts[m[1]] = (imageHosts[m[1]] || 0) + 1;
  const fonts = fontFaces(ssrCss + "\n" + ctx.stylesheets.map((s) => s.body).join("\n"), ctx.url);
  const fontHosts = {};
  for (const f of fonts) for (const s of f.src) if (s.url) { const h = new URL(s.url).host; fontHosts[h] = (fontHosts[h] || 0) + 1; }

  // Site id: search index meta or the site bundle URL.
  const siteId = rawHtml.match(/framerusercontent\.com\/sites\/([A-Za-z0-9]+)\//)?.[1] || null;
  const components = {};
  for (const n of els) { const t = attr(n, "data-framer-component-type"); if (t) components[t] = (components[t] || 0) + 1; }
  const collections = [...new Set([...handoverText.matchAll(/\\?"collection\\?"\s*:\s*\\?"([\w-]+)\\?"/g)].map((m) => m[1]))];

  return {
    generator: rawHtml.match(/<meta[^>]+name="generator"[^>]+content="([^"]+)"/)?.[1] || null,
    siteId,
    routeId: hydrate?.routeId || null,
    localeId: hydrate?.localeId || null,
    breakpoints: hydrate?.breakpoints || (appearBps ? json(textOf(appearBps)) : null),
    ssrReleasedAt: attr(main, "data-framer-ssr-released-at") || null,
    pageOptimizedAt: attr(main, "data-framer-page-optimized-at") || null,
    ssrCss: ssrCss ? { file: save("ssr", ssrCss, "css"), bytes: ssrCss.length, components: ssrEls.map((n) => attr(n, "data-framer-components") || "").join(" ").split(/\s+/).filter(Boolean).length } : null,
    breakpointCss: bpEl ? { file: save("breakpoints", textOf(bpEl), "css"), bytes: textOf(bpEl).length } : null,
    hiddenClasses,
    ssrVariants: els.filter((n) => classList(n).includes("ssr-variant")).length,
    cssBreakpoints: breakpointWidths(mediaQueries(ssrCss)).slice(0, 12),
    appear: {
      elements: appearEls,
      count: appearEls.length,
      animations: appearData ? { file: save("appear", JSON.stringify(appearData, null, 1), "json"), ids: Object.keys(appearData).length } : null,
      data: appearData && JSON.stringify(appearData).length < 50000 ? appearData : undefined,
      breakpoints: appearBps ? json(textOf(appearBps)) : null,
      animatorScript: animatorScript ? { file: save("animator", textOf(animatorScript), "js"), bytes: textOf(animatorScript).length } : null,
    },
    handover: handover ? { file: save("handover", handoverText, "json"), bytes: handoverText.length } : null,
    cms: { collections, hint: collections.length ? "CMS collection queries in handover data" : null },
    components,
    imageHosts,
    scaleDownVariants: (rawHtml.match(/scale-down-to=/g) || []).length,
    fonts: fonts.map((f) => ({ family: f.family, weight: f.weight, style: f.style, urls: f.src.filter((s) => s.url).length })),
    fontHosts,
    modules: ctx.scripts.map((s) => s.url).filter((u) => /framerusercontent\.com\/sites\//.test(u)),
  };
}

export const summarize = (f) => `breakpoints ${f.breakpoints?.length ?? 0}, ssr variants ${f.ssrVariants}, appear elements ${f.appear.count}, hidden classes ${Object.keys(f.hiddenClasses).length}`;
