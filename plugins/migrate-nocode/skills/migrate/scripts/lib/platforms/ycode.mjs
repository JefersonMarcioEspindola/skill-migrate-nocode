// Ycode (Next.js App Router + RSC). Platform data lives in the RSC payload (self.__next_f.push) of the raw HTML.
import { decodeFlight, flightRows } from "../common.mjs";
import { elements, attr, textOf, parseDecls, sha1, absUrl } from "../capture.mjs";

export const name = "ycode";

export function evidence(html, url, headers = {}) {
  const ev = [];
  if (/<meta[^>]+name="generator"[^>]+content="Ycode/i.test(html)) ev.push({ what: "generator meta Ycode", weight: 3 });
  if (/name="ycode-published-at"/.test(html)) ev.push({ what: "ycode-published-at meta", weight: 3 });
  if (/<style[^>]+id="ycode-styles"/.test(html)) ev.push({ what: "style#ycode-styles", weight: 3 });
  if (/id="ybody"/.test(html)) ev.push({ what: "#ybody root", weight: 2 });
  const lyr = (html.match(/data-layer-id="lyr-/g) || []).length;
  if (lyr) ev.push({ what: `data-layer-id="lyr-*" x${lyr}`, weight: 2 });
  if (/self\.__next_f\.push/.test(html)) ev.push({ what: "Next.js RSC payload", weight: 0 });
  void url; void headers;
  return ev;
}

export const detect = (html, url, headers) => evidence(html, url, headers).reduce((a, e) => a + e.weight, 0) >= 3;

/**
 * Interactions: the OWNER (trigger layer) is the object that CONTAINS the "interactions" key; its "id" is the
 * data-layer-id. (Taking "the last id before the key" in the text is wrong: nested children carry ids too.)
 */
function interactionsOf(rows) {
  const out = [];
  const seen = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v.interactions) && v.interactions.length) {
      const key = (v.id || "") + JSON.stringify(v.interactions);
      if (!seen.has(key)) { seen.add(key); out.push({ layerId: v.id || null, interactions: v.interactions }); }
    }
    for (const k of Object.keys(v)) if (k !== "interactions") walk(v[k]);
  };
  for (const row of rows) {
    if (row.type !== "row" || !row.text.includes('"interactions":[{')) continue;
    try { walk(JSON.parse(row.text)); } catch { /* row that is not plain JSON: ignored */ }
  }
  return out;
}

/** Ycode HTML embeds (component prop "html") that carry <script>: custom code that must be ported by hand. */
function htmlEmbedsOf(rows) {
  const out = [];
  const seen = new Set();
  const walk = (v, owner) => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, owner)); return; }
    if (!v || typeof v !== "object") return;
    const id = typeof v.id === "string" ? v.id : owner;
    if (typeof v.html === "string" && /<script/i.test(v.html) && !seen.has(v.html)) { seen.add(v.html); out.push({ layerId: id || null, html: v.html }); }
    for (const k of Object.keys(v)) walk(v[k], id);
  };
  for (const row of rows) {
    if (row.type === "T") { if (/<script/i.test(row.text) && !seen.has(row.text)) { seen.add(row.text); out.push({ layerId: null, rowId: row.id, html: row.text }); } continue; }
    if (!row.text.includes('"html":"')) continue;
    try { walk(JSON.parse(row.text)); } catch { /* ignored */ }
  }
  return out;
}

export function facts(rawHtml, renderedHtml, ctx) {
  const flight = decodeFlight(rawHtml);
  const rows = flight ? flightRows(flight) : [];
  const interactions = interactionsOf(rows);
  const embeds = htmlEmbedsOf(rows).map((e) => {
    const file = ctx.save(`custom-code/${sha1(e.html)}.html`, e.html);
    return { layerId: e.layerId, rowId: e.rowId || null, bytes: e.html.length, file, scripts: (e.html.match(/<script/gi) || []).length, srcs: [...e.html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]) };
  });
  // Custom code scripts can also be queued through self.__next_s.
  const nextS = [...rawHtml.matchAll(/\(self\.__next_s=self\.__next_s\|\|\[\]\)\.push\((\[[\s\S]*?\])\)<\/script>/g)].map((m) => m[1]);

  const doc = ctx.rawDoc;
  const styles = elements(doc).filter((n) => n.tagName === "style");
  const styleIds = styles.map((n) => attr(n, "id")).filter(Boolean);
  const colorVarsEl = styles.find((n) => attr(n, "id") === "ycode-color-vars");
  const colorVars = {};
  if (colorVarsEl) for (const m of textOf(colorVarsEl).matchAll(/\{([^}]*)\}/g)) for (const d of parseDecls(m[1])) if (d.prop.startsWith("--")) colorVars[d.prop] = d.value;
  const gsapInit = styles.find((n) => attr(n, "id") === "ycode-gsap-initial-styles");

  const publishedAt = rawHtml.match(/name="ycode-published-at"\s+content="([^"]+)"/)?.[1] || rawHtml.match(/content="([^"]+)"\s+name="ycode-published-at"/)?.[1] || null;
  const chunks = [...new Set([...rawHtml.matchAll(/<script[^>]+src="([^"]*\/_next\/static\/[^"]+\.js)"/g)].map((m) => absUrl(m[1], ctx.url)).filter(Boolean))];
  const layerIds = (rawHtml.match(/data-layer-id="/g) || []).length;

  return {
    publishedAt,
    dplId: rawHtml.match(/<html[^>]+data-dpl-id="([^"]+)"/)?.[1] || null,
    interactions,
    interactionOwners: interactions.map((x) => x.layerId),
    htmlEmbeds: embeds,
    nextS,
    styleIds,
    colorVars,
    gsapInitialStyles: gsapInit ? textOf(gsapInit) : null,
    layerIds,
    runtime: { chunks, rscRows: rows.length },
  };
}

export const summarize = (f) => `interactions ${f.interactions.length} (owners: ${f.interactionOwners.slice(0, 3).join(", ")}${f.interactionOwners.length > 3 ? ", ..." : ""}), embeds with <script> ${f.htmlEmbeds.length}`;
