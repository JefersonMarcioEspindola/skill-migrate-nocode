// Writes lib/migrate/pages-meta.json: the exact <head> of every snapshot route, shaped for Next.js generateMetadata
// (title, description, robots, alternates, openGraph, twitter, icons, manifest, other) plus what Metadata cannot
// express (htmlLang, htmlDir, bodyClass, JSON-LD, image preloads, viewport/themeColor as found) and a "mirror" map
// {head asset URL -> mirror path} for assets mirrored by assets.mjs. The 404 probe is stored under "__not_found__".
// Usage: node tools/migrate/gen-meta.mjs [--out lib/migrate/pages-meta.json]
import fs from "node:fs";
import path from "node:path";
import { config, latestSnapshot, arg } from "./lib/common.mjs";
import { readJson } from "./lib/capture.mjs";

const c = config();
const snap = latestSnapshot();
const map = readJson(path.join(snap, "assets-map.json"), {});
const outFile = path.resolve(process.cwd(), String(arg("out", "lib/migrate/pages-meta.json")));
const arr = (v) => (v == null ? [] : [].concat(v));
const one = (v) => (Array.isArray(v) ? v[0] : v ?? undefined);
const clean = (o) => {
  if (Array.isArray(o)) return o.map(clean).filter((x) => x !== undefined);
  if (o && typeof o === "object") {
    const r = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clean(v)]).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) && !(Array.isArray(v) && !v.length)));
    return Object.keys(r).length ? r : undefined;
  }
  return o === null ? undefined : o;
};
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };

/** og:image + og:image:width/height/alt/type (arrays aligned by index). */
function media(og, key) {
  const urls = arr(og[`${key}`] ?? og[`${key}:url`]);
  return urls.map((url, i) => ({ url, secureUrl: arr(og[`${key}:secure_url`])[i], width: arr(og[`${key}:width`])[i], height: arr(og[`${key}:height`])[i], alt: arr(og[`${key}:alt`])[i], type: arr(og[`${key}:type`])[i] }));
}

const out = {};
const counts = { title: 0, canonical: 0, ogImage: 0, jsonLd: 0 };
for (const f of fs.readdirSync(path.join(snap, "facts")).filter((x) => x.endsWith(".json"))) {
  const j = JSON.parse(fs.readFileSync(path.join(snap, "facts", f), "utf8"));
  const h = j.head;
  if (!h) continue;
  const key = j.slug === "404" ? "__not_found__" : j.route;
  const og = h.og || {};
  const tw = h.twitter || {};
  const handled = new Set(["description", "robots", "viewport", "theme-color", "generator", "keywords"]);
  const other = {};
  for (const m of h.metas || []) {
    const k = m.name ?? m.property;
    if (!k || m["http-equiv"] !== undefined) continue;
    const lk = k.toLowerCase();
    // Platform/runtime markers are not part of the site's metadata (verification metas are kept).
    if (handled.has(lk) || lk.startsWith("og:") || lk.startsWith("twitter:") || /^(next-size-adjust|ycode-|framer-)/.test(lk)) continue;
    other[k] = other[k] === undefined ? m.content : [].concat(other[k], m.content);
  }
  const icons = { icon: [], apple: [], shortcut: [], other: [] };
  for (const i of h.icons || []) {
    const e = { url: i.href, type: i.type || undefined, sizes: i.sizes || undefined, media: i.media || undefined };
    if (/apple-touch-icon/.test(i.rel)) icons.apple.push(e);
    else if (/shortcut/.test(i.rel)) icons.shortcut.push(e);
    else if (/(^|\s)icon(\s|$)/.test(i.rel)) icons.icon.push(e);
    else icons.other.push({ rel: i.rel, ...e, color: i.color });
  }
  const languages = {};
  for (const x of h.hreflang || []) languages[x.hreflang] = x.href;
  const ogExtra = Object.fromEntries(Object.entries(og).filter(([k]) => !/^og:(title|description|url|site_name|type|locale|image|video|audio)/.test(k)));
  const entry = {
    title: h.title ?? undefined,
    description: h.description ?? undefined,
    keywords: (h.metas || []).find((m) => m.name?.toLowerCase() === "keywords")?.content,
    robots: h.robots ?? undefined,
    alternates: { canonical: h.canonical ?? undefined, languages },
    openGraph: {
      title: one(og["og:title"]), description: one(og["og:description"]), url: one(og["og:url"]), siteName: one(og["og:site_name"]),
      type: one(og["og:type"]), locale: one(og["og:locale"]), alternateLocale: og["og:locale:alternate"],
      images: media(og, "og:image"), videos: media(og, "og:video"), audio: media(og, "og:audio"), extra: ogExtra,
    },
    twitter: {
      card: one(tw["twitter:card"]), site: one(tw["twitter:site"]), creator: one(tw["twitter:creator"]), title: one(tw["twitter:title"]),
      description: one(tw["twitter:description"]), images: arr(tw["twitter:image"] ?? tw["twitter:image:src"]), imageAlt: one(tw["twitter:image:alt"]),
    },
    icons,
    manifest: h.manifest ?? undefined,
    other,
    // Not expressible in Metadata (render in the layout / page):
    htmlLang: h.lang ?? undefined,
    htmlDir: h.dir ?? undefined,
    bodyClass: h.bodyClass || undefined,
    viewport: h.viewport ?? undefined,
    themeColor: h.themeColor ?? undefined,
    jsonLd: (h.jsonLd || []).map((x) => x.json ?? x.raw),
    preloads: (h.preloads || []).filter((p) => p.as === "image").map((p) => ({ href: p.href || undefined, imageSrcSet: p.imagesrcset || undefined, imageSizes: p.imagesizes || undefined, fetchPriority: p.fetchpriority || undefined, media: p.media || undefined })),
    status: j.status,
  };
  // Mirror paths of head assets (icons, og/twitter images, preloads) when assets.mjs downloaded them.
  const mirror = {};
  const base = j.finalUrl || c.live + "/";
  const heads = [...(h.icons || []).map((i) => i.href), ...entry.openGraph.images.map((i) => i.url), ...entry.twitter.images, h.manifest,
    ...entry.preloads.flatMap((p) => [p.href, ...String(p.imageSrcSet || "").split(/,\s*/).map((s) => s.trim().split(/\s+/)[0])])].filter(Boolean);
  for (const u of heads) { const a = abs(u, base); if (a && map[a]) mirror[u] = map[a]; }
  entry.mirror = mirror;
  out[key] = clean(entry) || {};
  if (entry.title) counts.title++;
  if (entry.alternates.canonical) counts.canonical++;
  if (entry.openGraph.images.length) counts.ogImage++;
  if (entry.jsonLd.length) counts.jsonLd++;
}

const sorted = Object.fromEntries(Object.keys(out).sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b))).map((k) => [k, out[k]]));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(sorted, null, 1));
console.log(`pages-meta: ${Object.keys(sorted).length} route(s) (title ${counts.title}, canonical ${counts.canonical}, og:image ${counts.ogImage}, json-ld ${counts.jsonLd}) -> ${path.relative(process.cwd(), outFile)}`);
