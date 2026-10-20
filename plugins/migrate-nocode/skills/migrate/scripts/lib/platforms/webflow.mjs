// Webflow. Interactions live in the site JS (webflow.js / webflow.<hash>.js chunks) as a JS object literal passed to
// Webflow.require("ix2").init({...}) (classic IX2) and Webflow.require("ix3")...register([...],[...]) (GSAP based IX3).
import { elements, attr, classList, literalCallArgs, mediaQueries, breakpointWidths, sha1 } from "../capture.mjs";

export const name = "webflow";

export function evidence(html, url, headers = {}) {
  const ev = [];
  const site = html.match(/data-wf-site="([^"]+)"/)?.[1];
  if (site) ev.push({ what: `data-wf-site="${site}"`, weight: 3 });
  const page = html.match(/data-wf-page="([^"]+)"/)?.[1];
  if (page) ev.push({ what: `data-wf-page="${page}"`, weight: 3 });
  if (/<meta[^>]+content="Webflow"[^>]+name="generator"|<meta[^>]+name="generator"[^>]+content="Webflow"/i.test(html)) ev.push({ what: "generator meta Webflow", weight: 3 });
  const cdn = (html.match(/website-files\.com|uploads-ssl\.webflow\.com/g) || []).length;
  if (cdn) ev.push({ what: `Webflow CDN refs x${cdn}`, weight: 1 });
  if (/webflow[\w.-]*\.js/.test(html)) ev.push({ what: "webflow*.js runtime", weight: 2 });
  if (/Last Published: /.test(html)) ev.push({ what: "Last Published comment", weight: 1 });
  if (/w-mod-js|w-nav|w-container/.test(html)) ev.push({ what: "w-* classes", weight: 1 });
  void url; void headers;
  return ev;
}

export const detect = (html, url, headers) => evidence(html, url, headers).reduce((a, e) => a + e.weight, 0) >= 3;

const COMPONENTS = ["w-nav", "w-nav-menu", "w-dropdown", "w-slider", "w-slide", "w-tabs", "w-tab-pane", "w-lightbox", "w-form", "w-background-video",
  "w-embed", "w-richtext", "w-dyn-list", "w-dyn-item", "w-dyn-empty", "w-pagination-wrapper", "w-tab-link", "w-checkbox", "w-radio", "w-select",
  "w-video", "w-iframe", "w-layout-grid", "w-layout-blockcontainer", "w-commerce-commercecartwrapper", "w-locales-list", "w-condition-invisible"];

/** IX2 events that run on this page: element/page targets with "<pageId>|..." ids, or class targets present here. */
function pageEvents(ix2, pageId, classSet) {
  const events = {};
  const lists = {};
  for (const [id, ev] of Object.entries(ix2.events || {})) {
    const targets = [ev.target, ...(ev.targets || [])].filter(Boolean);
    const hit = targets.some((t) => {
      if (t.appliesTo === "CLASS") return String(t.selector || t.id || "").split(/[\s.]+/).filter(Boolean).every((c) => classSet.has(c));
      return String(t.id || "").startsWith(pageId);
    });
    if (!hit) continue;
    events[id] = ev;
    const al = ev.action?.config?.actionListId;
    if (al && ix2.actionLists?.[al]) lists[al] = ix2.actionLists[al];
  }
  return { events, actionLists: lists };
}

export function facts(rawHtml, renderedHtml, ctx) {
  const doc = ctx.rawDoc;
  const els = elements(doc);
  const htmlEl = els.find((n) => n.tagName === "html");
  const pageId = attr(htmlEl, "data-wf-page") || null;
  const siteId = attr(htmlEl, "data-wf-site") || null;
  const classSet = new Set(els.flatMap(classList));

  // Components and CMS hints.
  const components = {};
  for (const c of COMPONENTS) { const n = els.filter((e) => classList(e).includes(c)).length; if (n) components[c] = n; }

  // Elements with data-w-id: IX2 triggers/targets; their server-rendered inline style is the animation initial state.
  const wIds = els.filter((n) => attr(n, "data-w-id")).map((n) => ({ wId: attr(n, "data-w-id"), tag: n.tagName, classes: classList(n), style: attr(n, "style") || null }));

  // Runtime scripts and interaction data (from bodies captured while rendering; no extra request).
  const wfScripts = ctx.scripts.filter((s) => /webflow[\w.-]*\.js/i.test(s.url) || /Webflow\.require|Webflow\.push/.test(s.body.slice(0, 2000)) || /require\(["']ix[23]["']\)/.test(s.body));
  let ix2 = null, ix3 = null, ix1 = null;
  const ixErrors = [];
  const modules = new Set();
  for (const s of wfScripts) {
    for (const m of s.body.matchAll(/Webflow\.require\(\s*["']([\w-]+)["']\s*\)/g)) modules.add(m[1]);
    for (const c of literalCallArgs(s.body, /\.require\(\s*["']ix2["']\s*\)\s*\.init/)) {
      if (c.error) { ixErrors.push(`ix2 in ${s.url}: ${c.error}`); continue; }
      const data = c.args[0];
      if (data && (data.events || data.actionLists)) ix2 = { ...data, script: s.url };
    }
    for (const c of literalCallArgs(s.body, /\.require\(\s*["']ix["']\s*\)\s*\.init/)) if (!c.error) ix1 = { data: c.args[0], script: s.url };
    if (/require\(\s*["']ix3["']\s*\)/.test(s.body)) {
      for (const c of literalCallArgs(s.body, /\.register/)) {
        if (c.error) { ixErrors.push(`ix3 in ${s.url}: ${c.error}`); continue; }
        const [interactions, timelines] = c.args;
        if (Array.isArray(interactions) && interactions.some((x) => x && x.triggers)) ix3 = { interactions, timelines: timelines || [], script: s.url };
      }
    }
  }

  const out = {
    siteId, pageId,
    domain: attr(htmlEl, "data-wf-domain") || null,
    collectionId: attr(htmlEl, "data-wf-collection") || null,
    itemSlug: attr(htmlEl, "data-wf-item-slug") || null,
    lastPublished: rawHtml.match(/Last Published: ([^-]+?) --/)?.[1]?.trim() || null,
    css: ctx.stylesheets.map((s) => s.href).filter((h) => /website-files\.com|webflow\.css|\.webflow\.[\w.]*css|\/css\//.test(h)),
    js: wfScripts.map((s) => s.url),
    modules: [...modules].sort(),
    components,
    cms: { dynLists: components["w-dyn-list"] || 0, dynItems: components["w-dyn-item"] || 0, empty: components["w-dyn-empty"] || 0, collectionPage: !!attr(htmlEl, "data-wf-collection") },
    wIdCount: wIds.length,
    wIdsWithStyle: wIds.filter((x) => x.style).length,
    wIds,
    ix2: null, ix3: null, ix1: ix1 ? { script: ix1.script, items: Array.isArray(ix1.data) ? ix1.data.length : null } : null,
    ixErrors,
    breakpoints: null,
    lottie: els.filter((n) => attr(n, "data-animation-type") === "lottie").map((n) => attr(n, "data-src")).filter(Boolean),
    backgroundVideos: els.filter((n) => classList(n).includes("w-background-video")).map((n) => ({ videoUrls: attr(n, "data-video-urls") || null, poster: attr(n, "data-poster-url") || null })),
  };

  if (ix2) {
    const json = JSON.stringify(ix2);
    const file = ctx.save(`platform/webflow-ix2-${sha1(json)}.json`, JSON.stringify(ix2, null, 1));
    const page = pageId ? pageEvents(ix2, pageId, classSet) : { events: {}, actionLists: {} };
    const types = {};
    for (const ev of Object.values(page.events)) types[ev.eventTypeId] = (types[ev.eventTypeId] || 0) + 1;
    out.ix2 = { file, script: ix2.script, events: Object.keys(ix2.events || {}).length, actionLists: Object.keys(ix2.actionLists || {}).length,
      mediaQueries: ix2.site?.mediaQueries || null, pageEventCount: Object.keys(page.events).length, pageEventTypes: types, page };
  }
  if (ix3) {
    const json = JSON.stringify(ix3);
    const file = ctx.save(`platform/webflow-ix3-${sha1(json)}.json`, JSON.stringify(ix3, null, 1));
    const onPage = ix3.interactions.filter((x) => x.deleted !== true && (x.scope?.type === "site" || (x.scope?.type === "pages" && (x.scope.value || []).includes(pageId))));
    const tl = new Set(onPage.flatMap((x) => x.timelineIds || []));
    const triggers = {};
    for (const x of onPage) for (const t of x.triggers || []) triggers[t[0]] = (triggers[t[0]] || 0) + 1;
    out.ix3 = { file, script: ix3.script, interactions: ix3.interactions.length, timelines: ix3.timelines.length, pageInteractionCount: onPage.length, pageTriggers: triggers,
      page: { interactions: onPage, timelines: ix3.timelines.filter((t) => tl.has(t.id)) } };
  }

  // Breakpoints: IX2 site media queries when present, plus the widths used by the Webflow CSS.
  const wfCss = ctx.stylesheets.filter((s) => out.css.includes(s.href)).map((s) => s.body).join("\n");
  out.breakpoints = { ix2: ix2?.site?.mediaQueries || null, css: breakpointWidths(mediaQueries(wfCss)).slice(0, 12) };
  return out;
}

export const summarize = (f) => `ix2 events ${f.ix2?.pageEventCount ?? 0}/${f.ix2?.events ?? 0} (page/site), ix3 interactions ${f.ix3?.pageInteractionCount ?? 0}/${f.ix3?.interactions ?? 0}, data-w-id ${f.wIdCount}, components ${Object.keys(f.components).length}`;
