// Step 3: list the sections (children of rootSelector) of a snapshot page and convert one section, a range or the
// whole root into a TSX component that keeps the live markup: same classes, every data-* and aria-*, literal text.
// Usage:
//   node tools/migrate/tojsx.mjs --page about --list                       (sections: index, tag, id, classes, text)
//   node tools/migrate/tojsx.mjs --page about --section 3 [--name AboutHero] [--out app/about/_sections/hero.tsx]
//   node tools/migrate/tojsx.mjs --page about --range 0-4 --name AboutTop --out ...
//   node tools/migrate/tojsx.mjs --page / --all --name HomePage --out ...
// Options: --page <slug|/route|file.html>  --root "<selector>" (override rootSelector)  --rendered (convert the rendered
//   DOM instead of the raw server HTML)  --i18n (internal hrefs -> localizePath(locale, href))  --unlazy (data-src ->
//   src)  --keep-urls (no asset rewriting)  --json (print the report)
// Rules: class->className, for->htmlFor, style string->object, text never trimmed (each text node is a JS string
// literal; NBSP, U+2028 and other invisible characters are written as \u escapes), whitespace between inline elements
// kept, void elements self-closed, SVG attributes camelCased, asset URLs (src/srcset/poster/style url()/lazy attrs)
// rewritten to mirror paths via assets-map.json, internal <a> -> next/link <Link> (all attributes kept), <script> and
// inline on* handlers dropped and listed in the header comment. Report: <outDir>/tojsx/<Name>.json.
import fs from "node:fs";
import path from "node:path";
import { config, latestSnapshot, arg, ROOT, slugOf, routeOf, isMirroredHost, mirrorPath, OUT_DIR } from "./lib/common.mjs";
import {
  parseHtml, querySelector, sectionNodes, skippedRootNodes, childrenOf, attr, classList, textOf, elements, parseSrcset,
  stringifySrcset, absUrl, cleanUrl, kindOf, isAssetKind, parseDecls, rewriteCssUrls, cssPath, sameSite, readJson, HTML_NS,
} from "./lib/capture.mjs";

// ---------------------------------------------------------------- attribute knowledge (React 19 / @types/react)

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen"]);
const RENAME = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", srcset: "srcSet", imagesrcset: "imageSrcSet", imagesizes: "imageSizes",
  fetchpriority: "fetchPriority", autoplay: "autoPlay", playsinline: "playsInline", crossorigin: "crossOrigin", readonly: "readOnly",
  maxlength: "maxLength", minlength: "minLength", novalidate: "noValidate", autocomplete: "autoComplete", autofocus: "autoFocus",
  enctype: "encType", contenteditable: "contentEditable", spellcheck: "spellCheck", colspan: "colSpan", rowspan: "rowSpan",
  allowfullscreen: "allowFullScreen", referrerpolicy: "referrerPolicy", frameborder: "frameBorder", srcdoc: "srcDoc",
  datetime: "dateTime", inputmode: "inputMode", enterkeyhint: "enterKeyHint", "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv", itemprop: "itemProp", itemscope: "itemScope", itemtype: "itemType", itemid: "itemID", itemref: "itemRef",
  accesskey: "accessKey", popovertarget: "popoverTarget", popovertargetaction: "popoverTargetAction", formaction: "formAction",
  formenctype: "formEncType", formmethod: "formMethod", formnovalidate: "formNoValidate", formtarget: "formTarget",
  disablepictureinpicture: "disablePictureInPicture", disableremoteplayback: "disableRemotePlayback", controlslist: "controlsList",
  nomodule: "noModule", charset: "charSet", hreflang: "hrefLang", srclang: "srcLang", usemap: "useMap", cellpadding: "cellPadding",
  cellspacing: "cellSpacing", marginheight: "marginHeight", marginwidth: "marginWidth", autocapitalize: "autoCapitalize",
  autocorrect: "autoCorrect", autosave: "autoSave", mediagroup: "mediaGroup", radiogroup: "radioGroup", classid: "classID",
};
// Lowercase names React accepts as-is.
const KNOWN = new Set(("accept action allow alt as async capture cite color content controls coords data default defer dir disabled download " +
  "draggable form headers height hidden high href id integrity is kind label lang list loop low manifest max media method min multiple muted name nonce " +
  "open optimum pattern ping placeholder poster preload rel required reversed role rows cols sandbox scope scoped scrolling seamless selected shape size " +
  "sizes slot span src start step summary target title translate type value width wrap wmode about datatype inlist prefix property resource typeof " +
  "vocab results security unselectable inert popover loading decoding checked").split(" "));
const NUMERIC = new Set(["tabIndex", "colSpan", "rowSpan", "maxLength", "minLength", "size", "rows", "cols", "span", "start", "marginHeight", "marginWidth", "high", "low", "optimum", "results"]);
const BOOL = new Set(["hidden", "disabled", "required", "readOnly", "multiple", "checked", "selected", "autoPlay", "loop", "muted", "controls", "playsInline",
  "async", "defer", "noModule", "open", "reversed", "allowFullScreen", "autoFocus", "noValidate", "formNoValidate", "default", "inert", "itemScope",
  "disablePictureInPicture", "disableRemotePlayback", "seamless", "scoped"]);
const BOOLISH = new Set(["draggable", "spellCheck"]);
// Element-specific props (@types/react types them per element). On any other element they go through a cast spread
// with the React name (React still renders the attribute, e.g. htmlFor -> for on a <span>).
const ON = (tags) => new Set(tags.split(" "));
const ELEMENT_ATTRS = {
  accept: ON("input"), acceptCharset: ON("form"), action: ON("form"), allow: ON("iframe"), allowFullScreen: ON("iframe"), alt: ON("img input area"),
  as: ON("link"), async: ON("script"), autoComplete: ON("input form select textarea"), autoPlay: ON("audio video"), capture: ON("input"),
  cellPadding: ON("table"), cellSpacing: ON("table"), charSet: ON("meta script"), checked: ON("input"), cite: ON("blockquote q del ins"),
  classID: ON("object"), cols: ON("textarea"), colSpan: ON("td th"), controls: ON("audio video"), controlsList: ON("audio video"), coords: ON("area"),
  crossOrigin: ON("audio video img link script input"), data: ON("object"), dateTime: ON("time del ins"), default: ON("track"), defer: ON("script"),
  disabled: ON("button fieldset input optgroup option select textarea link"), disablePictureInPicture: ON("video"), disableRemotePlayback: ON("video"),
  download: ON("a area"), encType: ON("form"), form: ON("button fieldset input label meter object output select textarea"),
  formAction: ON("button input"), formEncType: ON("button input"), formMethod: ON("button input"), formNoValidate: ON("button input"), formTarget: ON("button input"),
  frameBorder: ON("iframe"), headers: ON("td th"), height: ON("canvas embed iframe img input object video source td th"), high: ON("meter"),
  href: ON("a area base link"), hrefLang: ON("a area link"), htmlFor: ON("label output"), httpEquiv: ON("meta"), imageSrcSet: ON("link"), imageSizes: ON("link"),
  integrity: ON("link script"), kind: ON("track"), label: ON("track option optgroup"), list: ON("input"), loading: ON("img iframe"), decoding: ON("img"),
  fetchPriority: ON("img link script"), loop: ON("audio video"), low: ON("meter"), marginHeight: ON("iframe"), marginWidth: ON("iframe"),
  max: ON("input meter progress"), maxLength: ON("input textarea"), media: ON("a area link source style meta"), mediaGroup: ON("audio video"),
  method: ON("form"), min: ON("input meter"), minLength: ON("input textarea"), multiple: ON("input select"), muted: ON("audio video"),
  name: ON("button fieldset form iframe input map meta object output param select textarea slot"), noModule: ON("script"), noValidate: ON("form"),
  open: ON("details dialog"), optimum: ON("meter"), pattern: ON("input"), ping: ON("a area"), placeholder: ON("input textarea"), playsInline: ON("video"),
  poster: ON("video"), preload: ON("audio video"), readOnly: ON("input textarea"), referrerPolicy: ON("a area iframe img link script"),
  required: ON("input select textarea"), reversed: ON("ol"), rows: ON("textarea"), rowSpan: ON("td th"), sandbox: ON("iframe"), scope: ON("td th"),
  scrolling: ON("iframe"), seamless: ON("iframe"), selected: ON("option"), shape: ON("area"), size: ON("input select"), sizes: ON("img link source"),
  span: ON("col colgroup"), src: ON("audio embed iframe img input script source track video"), srcDoc: ON("iframe"), srcLang: ON("track"),
  srcSet: ON("img source"), start: ON("ol"), step: ON("input"), summary: ON("table"), target: ON("a area base form"),
  type: ON("a button embed input link object ol script source style"), useMap: ON("img object"),
  value: ON("button data input li meter option output param progress select textarea"),
  width: ON("canvas col embed iframe img input object table td th video source"), wmode: ON("object"), wrap: ON("textarea"), scoped: ON("style"),
};
const UNION = {
  crossOrigin: ["", "anonymous", "use-credentials"], loading: ["eager", "lazy"], decoding: ["async", "auto", "sync"], fetchPriority: ["high", "low", "auto"],
  referrerPolicy: ["", "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"],
  translate: ["yes", "no"], popover: ["", "auto", "manual"], popoverTargetAction: ["toggle", "show", "hide"],
  inputMode: ["none", "text", "tel", "url", "email", "numeric", "decimal", "search"], enterKeyHint: ["enter", "done", "go", "next", "previous", "search", "send"],
  contentEditable: ["true", "false", "inherit", "plaintext-only"], autoCapitalize: ["off", "none", "on", "sentences", "words", "characters"],
};
const UNION_BY_TAG = { button: { type: ["submit", "reset", "button"] }, ol: { type: ["1", "a", "A", "i", "I"] } };
const ARIA_NUM = new Set(["aria-level", "aria-colcount", "aria-colindex", "aria-colspan", "aria-posinset", "aria-rowcount", "aria-rowindex", "aria-rowspan", "aria-setsize", "aria-valuemax", "aria-valuemin", "aria-valuenow"]);
const TF = ["true", "false"];
const ARIA_UNION = {
  "aria-hidden": TF, "aria-expanded": TF, "aria-selected": TF, "aria-disabled": TF, "aria-modal": TF, "aria-multiline": TF, "aria-multiselectable": TF,
  "aria-readonly": TF, "aria-required": TF, "aria-atomic": TF, "aria-busy": TF, "aria-grabbed": TF,
  "aria-checked": [...TF, "mixed"], "aria-pressed": [...TF, "mixed"], "aria-current": [...TF, "page", "step", "location", "date", "time"],
  "aria-haspopup": [...TF, "menu", "listbox", "tree", "grid", "dialog"], "aria-invalid": [...TF, "grammar", "spelling"], "aria-live": ["off", "assertive", "polite"],
  "aria-orientation": ["horizontal", "vertical"], "aria-sort": ["none", "ascending", "descending", "other"], "aria-autocomplete": ["none", "inline", "list", "both"],
};
const SVG_CAMEL = new Set(("accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters " +
  "color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust " +
  "font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x " +
  "image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events " +
  "rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap " +
  "stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness " +
  "unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y " +
  "word-spacing writing-mode x-height").split(" "));
const SVG_NS_ATTR = { "xlink:href": "xlinkHref", "xlink:title": "xlinkTitle", "xlink:show": "xlinkShow", "xlink:role": "xlinkRole", "xlink:arcrole": "xlinkArcrole",
  "xlink:actuate": "xlinkActuate", "xlink:type": "xlinkType", "xml:space": "xmlSpace", "xml:lang": "xmlLang", "xml:base": "xmlBase", "xmlns:xlink": "xmlnsXlink" };
// Intrinsic elements known to @types/react; anything else is emitted through an ElementType alias (compiles, renders as-is).
const HTML_TAGS = new Set(("a abbr address area article aside audio b base bdi bdo big blockquote body br button canvas caption center cite code col colgroup data " +
  "datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img " +
  "input ins kbd keygen label legend li link main map mark menu menuitem meta meter nav noindex noscript object ol optgroup option output p param picture " +
  "pre progress q rp rt ruby s samp search slot script section select small source span strong style sub summary sup table template tbody td textarea " +
  "tfoot th thead time title tr track u ul var video wbr").split(" "));
const SVG_TAGS = new Set(("svg a style animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite " +
  "feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge " +
  "feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter foreignObject g image line linearGradient marker " +
  "mask metadata mpath path pattern polygon polyline radialGradient rect set stop switch symbol text textPath tspan use view title").split(" "));
// Whitespace-only text is invalid (hydration error) directly inside these.
const NO_WS = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup", "select", "optgroup", "html", "head"]);
const URL_ATTRS = new Set(["src", "poster", "data-src", "data-bg", "data-background", "data-background-image", "data-lazy-src", "data-poster-url", "data-poster", "data-lazy-background"]);
const LIST_URL_ATTRS = new Set(["data-video-urls"]);
const READONLY_VALUE_INPUTS = new Set(["button", "checkbox", "image", "hidden", "radio", "reset", "submit"]);

const INVISIBLE = /[\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u206a-\u206f\u3000\ufe00-\ufe0f\ufeff]/g;
/** JS string literal with invisible/special whitespace written as \u escapes (survives editors and formatters). */
export const jsStr = (s) => JSON.stringify(s).replace(INVISIBLE, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
const SAFE_ATTR = /^[\x20-\x7e]*$/;
const jsxAttr = (name, value) => (SAFE_ATTR.test(value) && !/["\\&{}<>]/.test(value) ? `${name}="${value}"` : `${name}={${jsStr(value)}}`);
const castSpread = (name, value) => `{...({ ${JSON.stringify(name)}: ${jsStr(value)} } as object)}`;
const castSpreadExpr = (name, expr) => `{...({ ${JSON.stringify(name)}: ${expr} } as object)}`;
const VALID_JSX_NAME = /^[A-Za-z_$][\w$-]*$/;
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
const isNum = (v) => /^-?\d+(\.\d+)?$/.test(String(v).trim());

function styleKey(k) {
  if (k.startsWith("--")) return JSON.stringify(k);
  const p = k.toLowerCase();
  if (p.startsWith("-ms-")) return camel(p.slice(1));
  if (/^-(webkit|moz|o)-/.test(p)) return camel(p.slice(1)).replace(/^./, (ch) => ch.toUpperCase());
  return camel(p);
}

// ---------------------------------------------------------------- loading

/** Resolves --page (slug, /route or .html file) to its file in the latest snapshot (raw HTML unless rendered). */
export function resolvePage(page = "index", { rendered = false } = {}) {
  const c = config();
  if (String(page).endsWith(".html") && fs.existsSync(page)) {
    const file = path.resolve(page);
    const snapDir = path.dirname(path.dirname(file));
    const slug = path.basename(file, ".html");
    return { file, slug, snapDir, pageUrl: readJson(path.join(snapDir, "facts", `${slug}.json`))?.finalUrl || c.live + (slug === "404" ? c.notFoundProbe : routeOf(slug)) };
  }
  const snapDir = latestSnapshot();
  const slug = String(page).startsWith("/") ? slugOf(page) : String(page);
  const raw = path.join(snapDir, "raw", `${slug}.html`);
  const ren = path.join(snapDir, "html", `${slug}.html`);
  const file = !rendered && fs.existsSync(raw) && fs.statSync(raw).size > 0 ? raw : ren;
  if (!fs.existsSync(file)) throw new Error(`No snapshot page "${slug}" in ${path.relative(ROOT, snapDir)} (run snapshot.mjs or check --page)`);
  const facts = readJson(path.join(snapDir, "facts", `${slug}.json`));
  return { file, slug, snapDir, pageUrl: facts?.finalUrl || c.live + (slug === "404" ? c.notFoundProbe : routeOf(slug)) };
}

export const loadDoc = (page, opts) => parseHtml(fs.readFileSync(resolvePage(page, opts).file, "utf8"));
export function rootOf(doc, selector = config().rootSelector) {
  const root = querySelector(doc, selector);
  if (!root) throw new Error(`root "${selector}" not found in the page (use --root, or --rendered for client-rendered pages)`);
  return root;
}
export const sectionsOf = (doc, selector) => sectionNodes(rootOf(doc, selector));

// ---------------------------------------------------------------- conversion

function newCtx(opts = {}) {
  const c = config();
  return {
    pageUrl: opts.pageUrl || c.live + "/", live: c.live, map: opts.map || {}, keepUrls: !!opts.keepUrls, i18n: !!opts.i18n, unlazy: !!opts.unlazy,
    locales: (c.locales || []).map((l) => String(typeof l === "object" ? l.code || l.id || "" : l)).filter(Boolean),
    images: new Set(), scripts: [], events: [], links: 0, warnings: [], unmapped: new Set(), aliases: new Map(), ids: new Set(), refs: new Set(),
    usesStyle: false, dropped: 0, forms: 0,
  };
}

function rewriteUrl(raw, ctx) {
  if (ctx.keepUrls || !raw) return null;
  const u = absUrl(raw, ctx.pageUrl);
  if (!u) return null;
  const hash = raw.includes("#") ? raw.slice(raw.indexOf("#")) : "";
  if (ctx.map[u]) return ctx.map[u] + hash;
  let host;
  try { host = new URL(u).host; } catch { return null; }
  if (isMirroredHost(host) && isAssetKind(kindOf(u))) { ctx.unmapped.add(u); return mirrorPath(u) + hash; }
  return null;
}
const rewriteSrcset = (v, ctx, collect) => {
  const parts = parseSrcset(v);
  let changed = false;
  for (const p of parts) { if (collect) collect(p.url); const r = rewriteUrl(p.url, ctx); if (r) { p.url = r; changed = true; } }
  return changed ? stringifySrcset(parts) : v;
};
const rewriteStyleUrls = (v, ctx) => (ctx.keepUrls ? v : rewriteCssUrls(v, ctx.pageUrl, (u, raw) => { const r = rewriteUrl(raw, ctx); return r ? r.replace(/#.*$/, "") : null; }));

function styleObject(s, ctx, where) {
  const decls = parseDecls(rewriteStyleUrls(s, ctx));
  const seen = new Map();
  let important = 0;
  for (const d of decls) { if (d.important) important++; if (seen.has(styleKey(d.prop))) ctx.warnings.push(`${where}: duplicate style "${d.prop}" (last kept)`); seen.set(styleKey(d.prop), d.value); }
  if (important) ctx.warnings.push(`${where}: ${important} inline !important dropped (React style objects cannot set it)`);
  ctx.usesStyle = true;
  return `{${[...seen].map(([k, v]) => `${k}: ${jsStr(v)}`).join(", ")}} as CSSProperties`;
}

function collectRefs(tag, name, value, ctx) {
  if ((name === "href" || name === "xlink:href") && value.length > 1 && value.startsWith("#") && /^(use|image|feImage|textPath|mpath)$/.test(tag)) ctx.refs.add(value.slice(1));
  for (const m of String(value).matchAll(/url\(\s*["']?#([^"')\s]+)/g)) ctx.refs.add(m[1]);
}

function localizedHref(p, ctx) {
  let out = p;
  for (const l of ctx.locales) {
    const re = new RegExp(`^/${l.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?=/|$|\\?|#)`, "i");
    if (re.test(out)) { out = out.replace(re, "") || "/"; break; }
  }
  if (out.startsWith("?") || out.startsWith("#")) out = "/" + out;
  return out;
}

/** Converts parse5 nodes to JSX lines. ctx collects images, scripts, links, warnings... */
export function convert(nodes, ctx = newCtx(), indent = "      ") {
  const out = [];
  const tagName = (n, inSvg) => {
    const t = n.tagName;
    if ((inSvg ? SVG_TAGS : HTML_TAGS).has(t)) return t;
    const alias = "Tag_" + t.replace(/[^A-Za-z0-9]/g, "_");
    ctx.aliases.set(alias, t);
    return alias;
  };

  const emit = (n, ind, inSvg, parentTag) => {
    if (n.nodeName === "#comment" || n.nodeName === "#documentType") return;
    if (n.nodeName === "#text") {
      if (!n.value.length) return;
      if (!n.value.trim() && NO_WS.has(parentTag)) return;
      out.push(ind + `{${jsStr(n.value)}}`);
      return;
    }
    const tag = n.tagName;
    if (tag.includes(":")) { ctx.dropped++; return; } // editor metadata (sodipodi:*, inkscape:*)
    if (tag === "script") {
      const src = attr(n, "src");
      ctx.scripts.push(src ? `src ${src}` : `inline ${(attr(n, "type") || "")} ${textOf(n).replace(/\s+/g, " ").trim().slice(0, 140)}`.replace(/\s+/g, " "));
      return;
    }
    const svg = inSvg || tag === "svg";
    const childSvg = svg && tag !== "foreignObject";
    let jsxTag = tagName(n, svg);
    const attrs = [];
    const a0 = (n.attrs || []).map((x) => ({ name: x.prefix ? `${x.prefix}:${x.name}` : x.name, value: x.value }));
    if (ctx.unlazy && (tag === "img" || tag === "source" || tag === "video")) {
      const get = (k) => a0.find((x) => x.name === k)?.value;
      const set = (k, v) => { const e = a0.find((x) => x.name === k); if (e) e.value = v; else a0.push({ name: k, value: v }); };
      const lazySrc = get("data-lazy-src") || get("data-src");
      const lazySet = get("data-lazy-srcset") || get("data-srcset");
      const src = get("src");
      if (lazySrc && (!src || src.startsWith("data:") || /placeholder|blank|lazy/i.test(src))) set("src", lazySrc);
      if (lazySet) set("srcset", lazySet);
    }
    const id = a0.find((x) => x.name === "id")?.value;
    if (id) ctx.ids.add(id);
    const where = `<${tag}${id ? "#" + id : ""}>`;
    const inputType = (a0.find((x) => x.name === "type")?.value || "text").toLowerCase();
    if (tag === "form") ctx.forms++;

    for (const { name, value: v0 } of a0) {
      let value = v0;
      if (/^on[a-z]+$/i.test(name)) { ctx.events.push(`${tag} ${name}`); continue; }
      collectRefs(tag, name, value, ctx);
      // Asset URLs -> mirror paths.
      // Images used (img/source src+srcset, poster, style url()), reported with their mirror path when known.
      const img = (u) => { const a = absUrl(u, ctx.pageUrl); if (a && kindOf(a) !== "media") ctx.images.add(ctx.map[a] || a); };
      if ((tag === "img" || tag === "source") && (name === "src" || name === "srcset")) (name === "src" ? [value] : parseSrcset(value).map((p) => p.url)).forEach(img);
      if (name === "poster") img(value);
      if (name === "style") for (const m of value.matchAll(/url\(\s*["']?([^"')]+)/g)) img(m[1]);
      if (/srcset$/i.test(name)) value = rewriteSrcset(value, ctx);
      else if (LIST_URL_ATTRS.has(name)) value = value.split(",").map((p) => rewriteUrl(p.trim(), ctx) || p).join(",");
      else if (URL_ATTRS.has(name) || ((name === "href" || name === "xlink:href") && tag !== "a") || (tag === "a" && name === "href" && ctx.map[absUrl(value, ctx.pageUrl)])) {
        if (/url\(/i.test(value)) value = rewriteStyleUrls(value, ctx);
        else value = rewriteUrl(value, ctx) || value;
      }

      if (name === "style") { attrs.push(`style={${styleObject(value, ctx, where)}}`); continue; }

      // Internal links -> next/link.
      if (tag === "a" && !svg && name === "href" && value === v0 && !value.startsWith("#") && !/^(mailto|tel|javascript|sms):/i.test(value)) {
        let u = null;
        try { u = new URL(cleanUrl(value), ctx.pageUrl); } catch { /* keep as is */ }
        if (u && /^https?:$/.test(u.protocol) && sameSite(u.href, ctx.live) && !isAssetKind(kindOf(u.href))) {
          jsxTag = "Link";
          ctx.links++;
          const p = u.pathname + u.search + u.hash;
          attrs.push(ctx.i18n ? `href={localizePath(locale, ${jsStr(localizedHref(p, ctx))})}` : jsxAttr("href", p));
          continue;
        }
      }
      if (tag === "a" && name === "href" && /^javascript:/i.test(value)) ctx.warnings.push(`${where}: javascript: href kept (React 19 blocks it at runtime)`);

      // Form state -> uncontrolled defaults.
      if ((tag === "input" && name === "value" && !READONLY_VALUE_INPUTS.has(inputType)) || (tag === "textarea" && name === "value")) { attrs.push(jsxAttr("defaultValue", value)); continue; }
      if (tag === "input" && name === "checked") { attrs.push("defaultChecked"); continue; }
      if (tag === "option" && name === "selected") continue;

      // Attribute name mapping.
      if (svg) {
        if (name === "class") { attrs.push(jsxAttr("className", value)); continue; }
        if (SVG_NS_ATTR[name]) { attrs.push(jsxAttr(SVG_NS_ATTR[name], value)); continue; }
        if (name.includes(":")) { ctx.dropped++; continue; } // sodipodi:*, inkscape:*, xmlns:sodipodi...
        if (name.startsWith("data-") || name.startsWith("aria-")) { attrs.push(VALID_JSX_NAME.test(name) ? jsxAttr(name, value) : castSpread(name, value)); continue; }
        if (name === "tabindex") { attrs.push(isNum(value) ? `tabIndex={${Number(value)}}` : castSpread(name, value)); continue; }
        if (SVG_CAMEL.has(name)) { attrs.push(jsxAttr(camel(name), value)); continue; }
        attrs.push(VALID_JSX_NAME.test(name) ? jsxAttr(name, value) : castSpread(name, value));
        continue;
      }
      if (name.startsWith("aria-")) {
        if (!VALID_JSX_NAME.test(name)) attrs.push(castSpread(name, value));
        else if (ARIA_NUM.has(name)) attrs.push(isNum(value) ? `${name}={${Number(value)}}` : castSpread(name, value));
        else if (ARIA_UNION[name]) attrs.push(ARIA_UNION[name].includes(value) ? jsxAttr(name, value) : castSpread(name, value));
        else attrs.push(jsxAttr(name, value));
        continue;
      }
      if (name.startsWith("data-")) { attrs.push(VALID_JSX_NAME.test(name) ? jsxAttr(name, value) : castSpread(name, value)); continue; }
      const jsxName = RENAME[name] || (KNOWN.has(name) ? name : null);
      if (!jsxName) {
        // Custom attribute: hyphenated names are allowed by TS as-is; anything else goes through a spread.
        attrs.push(name.includes("-") && VALID_JSX_NAME.test(name) ? jsxAttr(name, value) : castSpread(name, value));
        continue;
      }
      if (ELEMENT_ATTRS[jsxName] && !ELEMENT_ATTRS[jsxName].has(tag) && !ctx.aliases.has(jsxTag)) {
        attrs.push(BOOL.has(jsxName) ? castSpreadExpr(jsxName, "true") : NUMERIC.has(jsxName) && isNum(value) ? castSpreadExpr(jsxName, String(Number(value))) : castSpread(jsxName, value));
        continue;
      }
      if (BOOL.has(jsxName)) {
        if (jsxName === "hidden" && value && value !== "hidden" && value !== "true") attrs.push(castSpread(name, value));
        else attrs.push(jsxName);
        continue;
      }
      if (NUMERIC.has(jsxName)) { attrs.push(isNum(value) ? `${jsxName}={${Number(value)}}` : castSpread(name, value)); continue; }
      if (BOOLISH.has(jsxName)) { attrs.push(TF.includes(value) ? jsxAttr(jsxName, value) : value === "" ? jsxName : castSpread(name, value)); continue; }
      const allowed = UNION_BY_TAG[tag]?.[jsxName] || UNION[jsxName];
      if (allowed && !allowed.includes(value)) {
        if (jsxName === "contentEditable" && value === "") attrs.push(jsxName);
        else attrs.push(castSpread(name, value));
        continue;
      }
      attrs.push(jsxAttr(jsxName, value));
    }

    if (tag === "select") {
      const opts = elements(n).filter((o) => o.tagName === "option" && (o.attrs || []).some((x) => x.name === "selected"));
      const vals = opts.map((o) => attr(o, "value") ?? textOf(o));
      if (vals.length) attrs.push(attr(n, "multiple") !== undefined ? `defaultValue={${JSON.stringify(vals)}}` : jsxAttr("defaultValue", vals[0]));
    }
    if (tag === "video" && a0.some((x) => x.name === "autoplay") && a0.some((x) => x.name === "muted"))
      ctx.warnings.push(`${where}: autoplay+muted video: React does not serialize "muted" in SSR HTML, autoplay may wait for hydration`);

    const open = `<${jsxTag}${attrs.length ? " " + attrs.join(" ") : ""}`;
    if (tag === "style" || tag === "noscript") { const t = textOf(n); out.push(`${ind}${open}${t ? ` dangerouslySetInnerHTML={{ __html: ${jsStr(t)} }}` : ""} />`); return; }
    if (tag === "textarea") { const t = textOf(n); out.push(`${ind}${open}${t ? " " + jsxAttr("defaultValue", t) : ""} />`); return; }
    const kids = childrenOf(n);
    if (VOID.has(tag) || !kids.length) { out.push(`${ind}${open} />`); return; }
    out.push(`${ind}${open}>`);
    for (const k of kids) emit(k, ind + "  ", childSvg, tag);
    out.push(`${ind}</${jsxTag}>`);
  };
  for (const n of nodes) emit(n, indent, n.namespaceURI && n.namespaceURI !== HTML_NS && n.tagName !== "svg", n.parentNode?.tagName);
  return { jsx: out.join("\n"), ctx };
}

const comment = (s) => "// " + String(s).replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\*\//g, "* /");

/** Full component source. opts: { pageUrl, map, i18n, unlazy, keepUrls, source, note } */
export function componentSource(name, nodes, opts = {}) {
  const c = config();
  const ctx = newCtx(opts);
  const { jsx } = convert(nodes, ctx);
  const external = [...ctx.refs].filter((r) => !ctx.ids.has(r));
  if (external.length && opts.doc) for (const r of external) {
    const def = elements(opts.doc).find((e) => attr(e, "id") === r);
    ctx.warnings.push(`references #${r} defined outside the converted nodes${def ? ` (at ${cssPath(def)}): convert it too` : ""}`);
  }
  if (ctx.unmapped.size) ctx.warnings.push(`${ctx.unmapped.size} mirrored asset(s) not in assets-map.json yet (run assets.mjs)`);
  if (ctx.dropped) ctx.warnings.push(`${ctx.dropped} editor-namespaced svg element(s)/attribute(s) dropped (sodipodi:/inkscape: metadata)`);
  const i18nCfg = c.i18n || {};
  const head = [
    "/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages */",
    comment(`Converted by tools/migrate/tojsx.mjs from ${opts.source || "snapshot"}${opts.note ? ` (${opts.note})` : ""}.`),
    comment("Same classes and attributes as the live site; text nodes are literal (invisible characters as \\u escapes). Do not reformat."),
    ...(ctx.scripts.length ? [comment(`Scripts removed (${ctx.scripts.length}), port by hand:`), ...ctx.scripts.slice(0, 30).map((s) => comment(`  - ${s}`))] : []),
    ...(ctx.events.length ? [comment(`Inline event handlers removed: ${[...new Set(ctx.events)].join(", ").slice(0, 400)}`)] : []),
    ...(ctx.forms ? [comment(`${ctx.forms} <form>: submission must be re-implemented`)] : []),
    ctx.links ? 'import Link from "next/link";' : "",
    ctx.usesStyle || ctx.aliases.size ? `import type { ${[ctx.usesStyle ? "CSSProperties" : "", ctx.aliases.size ? "ElementType" : ""].filter(Boolean).join(", ")} } from "react";` : "",
    ctx.i18n ? `import type { Locale } from "${i18nCfg.configModule || "@/lib/i18n/config"}";` : "",
    ctx.i18n && ctx.links ? `import { localizePath } from "${i18nCfg.pathsModule || "@/lib/i18n/paths"}";` : "",
  ].filter(Boolean).join("\n");
  const aliases = [...ctx.aliases].map(([alias, t]) => `const ${alias} = ${JSON.stringify(t)} as ElementType;`).join("\n");
  const sig = ctx.i18n ? `{ locale }: { locale: Locale }` : "";
  const body = ctx.i18n && !ctx.links ? "  void locale;\n" : "";
  const src = `${head}\n${aliases ? "\n" + aliases + "\n" : ""}\nexport default function ${name}(${sig}) {\n${body}  return (\n    <>\n${jsx}\n    </>\n  );\n}\n`;
  return { src, ctx };
}

// ---------------------------------------------------------------- CLI

function selectorHint(rootSel, child) {
  const id = attr(child, "id");
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
  const cls = classList(child).filter((x) => /^[A-Za-z_-][\w-]*$/.test(x)).slice(0, 3);
  return `${rootSel} > ${child.tagName}${cls.map((x) => "." + x).join("")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = config();
  const pg = resolvePage(arg("page", "index"), { rendered: Boolean(arg("rendered")) });
  const html = fs.readFileSync(pg.file, "utf8");
  const doc = parseHtml(html);
  const rootSel = typeof arg("root") === "string" ? arg("root") : c.rootSelector;
  const root = rootOf(doc, rootSel);
  const secs = sectionNodes(root);
  const srcRel = path.relative(ROOT, pg.file);

  if (arg("list")) {
    secs.forEach((s, i) => {
      const id = attr(s, "id");
      const idv = c.idAttribute && c.idAttribute !== "id" ? attr(s, c.idAttribute) : null;
      const txt = textOf(s).replace(/\s+/g, " ").trim().slice(0, 60);
      console.log(`${i}\t<${s.tagName}>${id ? " #" + id : ""}${idv ? ` ${c.idAttribute}=${idv}` : ""}\t${classList(s).join(" ").slice(0, 60)}\t"${txt}"`);
    });
    const skipped = skippedRootNodes(root).length;
    console.log(`${secs.length} section(s) in ${rootSel} of ${srcRel}${skipped ? ` (${skipped} script/link/meta nodes skipped)` : ""}`);
    if (secs.length === 1) {
      let n = secs[0], sel = selectorHint(rootSel, n);
      for (let d = 0; d < 5; d++) {
        const kids = sectionNodes(n);
        if (kids.length > 1) { console.log(`hint: single wrapper; --root "${sel}" has ${kids.length} children`); break; }
        if (!kids.length) break;
        n = kids[0];
        sel = selectorHint(sel, n);
      }
    }
    process.exit(0);
  }

  let nodes, note;
  const range = arg("range");
  if (arg("all")) { nodes = secs; note = `all ${secs.length} sections of ${rootSel}`; }
  else if (typeof range === "string") { const [a, b] = range.split("-").map(Number); nodes = secs.slice(a, (Number.isFinite(b) ? b : a) + 1); note = `sections ${a}-${b} of ${rootSel}`; }
  else { const i = Number(arg("section", 0)); nodes = [secs[i]].filter(Boolean); note = `section ${i} of ${rootSel}`; }
  if (!nodes.length) { console.error(`no sections selected (root has ${secs.length})`); process.exit(1); }
  if (arg("all")) nodes = [...nodes, ...skippedRootNodes(root).filter((n) => n.tagName === "script")];

  const name = String(arg("name", arg("all") ? pg.slug.replace(/(^|[^A-Za-z0-9])([a-z0-9])/g, (_, __, ch) => ch.toUpperCase()).replace(/[^A-Za-z0-9]/g, "") + "Page" : "Section"));
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) { console.error(`--name must be a PascalCase identifier (got "${name}")`); process.exit(1); }
  const map = readJson(path.join(pg.snapDir, "assets-map.json"), {});
  const { src, ctx } = componentSource(name, nodes, {
    pageUrl: pg.pageUrl, map, i18n: Boolean(arg("i18n")), unlazy: Boolean(arg("unlazy")), keepUrls: Boolean(arg("keep-urls")), source: srcRel, note, doc,
  });
  if (!Object.keys(map).length && !arg("keep-urls")) ctx.warnings.push("assets-map.json missing: URLs rewritten with mirrorPath() but nothing is downloaded yet");
  const report = {
    name, source: srcRel, pageUrl: pg.pageUrl, root: rootSel, note, bytes: src.length, images: [...ctx.images], internalLinks: ctx.links,
    scriptsRemoved: ctx.scripts, eventsRemoved: ctx.events, forms: ctx.forms, unmapped: [...ctx.unmapped], aliases: Object.fromEntries(ctx.aliases), warnings: ctx.warnings,
  };
  const repFile = path.join(OUT_DIR(), "tojsx", `${name}.json`);
  fs.mkdirSync(path.dirname(repFile), { recursive: true });
  fs.writeFileSync(repFile, JSON.stringify(report, null, 1));
  const out = arg("out");
  if (typeof out === "string") { const dest = path.isAbsolute(out) ? out : path.join(process.cwd(), out); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, src); }
  else if (!arg("json")) process.stdout.write(src.length > 4000 ? src.slice(0, 4000) + "\n// ... (truncated; use --out)\n" : src);
  if (arg("json")) console.log(JSON.stringify(report, null, 1));
  const imgs = report.images.map((u) => u.replace(/^https?:\/\/[^/]+/, ""));
  console.error(`${name}: ${src.length} chars, ${note}; images ${imgs.length}, internal links ${ctx.links}, scripts removed ${ctx.scripts.length}, handlers removed ${ctx.events.length}, warnings ${ctx.warnings.length}${typeof out === "string" ? ` -> ${out}` : ""}`);
  if (imgs.length) console.error(`  images: ${imgs.slice(0, 6).join(", ")}${imgs.length > 6 ? `, +${imgs.length - 6} more` : ""}`);
  for (const w of ctx.warnings.slice(0, 4)) console.error(`  warning: ${w}`);
  console.error(`  report: ${path.relative(process.cwd(), repFile)}`);
}
