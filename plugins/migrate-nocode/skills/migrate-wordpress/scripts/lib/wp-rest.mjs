// Public WordPress REST API reader (no auth, read-only). Every response is cached under rawDir so a run can be
// replayed offline with --from-raw (and so the site is hit once). Only status + pagination headers are stored.
import fs from "node:fs";
import path from "node:path";
import { makeClient, redactUrl } from "./content-common.mjs";

export const NAMESPACE_PLUGINS = {
  "acf/v3": "ACF to REST API", "yoast/v1": "Yoast SEO", "rankmath/v1": "Rank Math", "jet-engine/v2": "JetEngine", "jet-cct": "JetEngine CCT", "wc/v3": "WooCommerce", "wc/store": "WooCommerce", "wc/store/v1": "WooCommerce",
  "elementor/v1": "Elementor", "contact-form-7/v1": "Contact Form 7", "pll/v1": "Polylang Pro", "wpml/v1": "WPML", "redirection/v1": "Redirection", "jetpack/v4": "Jetpack", "akismet/v1": "Akismet", "aioseo/v1": "AIOSEO", "seopress/v1": "SEOPress", "wpcom/v2": "Jetpack/WordPress.com", "gf/v2": "Gravity Forms", "tribe/events/v1": "The Events Calendar", "ldlms/v2": "LearnDash", "rankmath/v1/headless": "Rank Math headless",
};

export class RestSource {
  /** site: https://example.com (no /wp-json). rawDir: where responses are cached. offline: read only from rawDir. */
  constructor({ site, rawDir, offline = false, minIntervalMs = 400, onRetry }) {
    this.site = String(site || "").replace(/\/+$/, "").replace(/\/wp-json.*$/, "");
    this.rawDir = rawDir;
    this.offline = offline;
    this.client = makeClient({ minIntervalMs, onRetry, userAgent: "migrate-nocode-content/1.0 (+content migration; polite crawler)" });
    this.apiRoot = null; // "https://x/wp-json" or "rest_route"
    this.requests = 0;
    if (rawDir) fs.mkdirSync(rawDir, { recursive: true });
  }

  key(route, query) {
    const q = Object.entries(query || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    return (route.replace(/^\//, "") + (q ? "__" + q : "")).replace(/[^\w.=-]+/g, "_").slice(0, 180) + ".json";
  }

  url(route, query = {}) {
    const qs = new URLSearchParams(query).toString();
    if (this.apiRoot === "rest_route") return `${this.site}/?rest_route=${encodeURIComponent(route)}${qs ? "&" + qs : ""}`;
    return `${this.apiRoot || this.site + "/wp-json"}${route}${qs ? "?" + qs : ""}`;
  }

  async get(route, query = {}) {
    const file = this.rawDir ? path.join(this.rawDir, this.key(route, query)) : null;
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    if (this.offline) return { status: 0, body: null, missing: true };
    const res = await this.client(this.url(route, query));
    this.requests++;
    const out = { status: res.status, total: num(res.headers.get("x-wp-total")), totalPages: num(res.headers.get("x-wp-totalpages")), body: res.json ?? null };
    if (file && res.status < 500) fs.writeFileSync(file, JSON.stringify(out, null, 1));
    return out;
  }

  /** Finds the API root: /wp-json/, then ?rest_route=/, then the <link rel="https://api.w.org/"> of the homepage. */
  async discover() {
    const meta = this.rawDir ? path.join(this.rawDir, "_api-root.json") : null;
    if (meta && fs.existsSync(meta)) { this.apiRoot = JSON.parse(fs.readFileSync(meta, "utf8")).apiRoot; }
    else if (!this.offline) {
      for (const cand of [this.site + "/wp-json", "rest_route"]) {
        this.apiRoot = cand;
        const r = await this.client(this.url("/"));
        this.requests++;
        if (r.ok && r.json && (r.json.namespaces || r.json.routes)) break;
        this.apiRoot = null;
      }
      if (!this.apiRoot) {
        const home = await this.client(this.site + "/", { accept: "text/html" });
        const m = /<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*href=["']([^"']+)["']/i.exec(home.text || "") || /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(home.headers?.get?.("link") || "");
        if (m) this.apiRoot = m[1].replace(/\/$/, "");
      }
      if (!this.apiRoot) throw new Error(`no public REST API found at ${redactUrl(this.site)} (tried /wp-json/ and ?rest_route=/)`);
      if (meta) fs.writeFileSync(meta, JSON.stringify({ apiRoot: this.apiRoot }));
    }
    const root = await this.get("/");
    const types = await this.get("/wp/v2/types");
    const taxonomies = await this.get("/wp/v2/taxonomies");
    return {
      root: root.body ? { name: root.body.name, description: root.body.description, url: root.body.url, home: root.body.home, timezone: root.body.timezone_string, gmtOffset: root.body.gmt_offset, namespaces: root.body.namespaces || [], routes: Object.keys(root.body.routes || {}).length } : null,
      types: types.body && typeof types.body === "object" ? Object.values(types.body) : [],
      taxonomies: taxonomies.body && typeof taxonomies.body === "object" ? Object.values(taxonomies.body) : [],
    };
  }

  /** Fetches every page of a collection route (per_page max 100). Returns { items, total, pages, status, truncated }. */
  async all(route, query = {}, { perPage = 100, maxPages = Infinity } = {}) {
    const items = [];
    let page = 1, pages = 1, total, status;
    do {
      const r = await this.get(route, { ...query, per_page: perPage, page });
      status = r.status;
      if (r.missing || r.status >= 400 || !Array.isArray(r.body)) break;
      items.push(...r.body);
      pages = r.totalPages ?? (r.body.length < perPage ? page : page + 1);
      total = r.total;
      page++;
    } while (page <= pages && page <= maxPages);
    return { items, total, pages, status, truncated: page <= pages };
  }
}

const num = (v) => (v === null || v === undefined || v === "" ? undefined : Number(v));

export function pluginsFromNamespaces(ns = []) {
  const found = new Set();
  for (const n of ns) { for (const [k, v] of Object.entries(NAMESPACE_PLUGINS)) if (n === k || n.startsWith(k + "/") || (k.endsWith("/") && n.startsWith(k))) found.add(v); }
  return [...found];
}
