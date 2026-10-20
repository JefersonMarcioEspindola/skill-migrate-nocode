// Shared helpers for the migration tools. Every tool reads migrate.config.json from the project root
// (the current working directory) so the same scripts work for Ycode, Webflow, Framer and WordPress.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = process.cwd();
const CONFIG_FILE = path.join(ROOT, "migrate.config.json");

/** Defaults per platform. Anything here can be overridden in migrate.config.json. */
export const PLATFORM_PRESETS = {
  ycode: {
    rootSelector: "#ybody",
    idAttribute: "data-layer-id",
    assetHosts: ["*.supabase.co", "fonts.gstatic.com", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
  },
  webflow: {
    rootSelector: "body",
    idAttribute: "data-w-id",
    assetHosts: ["cdn.prod.website-files.com", "*.website-files.com", "uploads-ssl.webflow.com", "d3e54v103j8qbb.cloudfront.net", "fonts.gstatic.com", "fonts.googleapis.com", "ajax.googleapis.com"],
  },
  framer: {
    rootSelector: "#main",
    idAttribute: "data-framer-name",
    assetHosts: ["framerusercontent.com", "*.framerusercontent.com", "fonts.gstatic.com", "fonts.googleapis.com"],
  },
  wordpress: {
    rootSelector: "body",
    idAttribute: "data-id",
    assetHosts: ["fonts.gstatic.com", "fonts.googleapis.com", "*.wp.com", "i0.wp.com", "i1.wp.com", "i2.wp.com"],
  },
  other: { rootSelector: "body", idAttribute: "id", assetHosts: ["fonts.gstatic.com", "fonts.googleapis.com"] },
};

const DEFAULTS = {
  platform: "other",
  live: "",
  local: "http://localhost:3100",
  widths: [1920, 1440, 768, 390],
  locales: [],
  routes: [],
  excludeRoutes: [],
  notFoundProbe: "/__migrate-404-probe",
  snapshotsDir: "snapshots",
  outDir: "tools/out",
  staticFlag: "__migrateStatic",
  dynamicRegions: [],
  publicDir: "public",
  mirrorPrefix: "/_m",
  defaultLocale: null,
  reviewLang: "en",
  userAgent: null,
  browserLocale: null,
  snapshot: null,
  i18n: {},
};

let cached;
/** Loads migrate.config.json merged over the platform preset and defaults. Env vars win: LIVE_URL, LOCAL_URL, MIGRATE_OUT. */
export function config() {
  if (cached) return cached;
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`migrate.config.json not found in ${ROOT}. Create it first (see the migrate skill, references/config.md).`);
  }
  const user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const preset = PLATFORM_PRESETS[user.platform || "other"] || PLATFORM_PRESETS.other;
  const c = { ...DEFAULTS, ...preset, ...user };
  c.assetHosts = [...new Set([...(preset.assetHosts || []), ...(user.assetHosts || [])])];
  if (process.env.LIVE_URL) c.live = process.env.LIVE_URL;
  if (process.env.LOCAL_URL) c.local = process.env.LOCAL_URL;
  if (process.env.MIGRATE_OUT) c.outDir = process.env.MIGRATE_OUT;
  c.live = c.live.replace(/\/$/, "");
  c.local = c.local.replace(/\/$/, "");
  if (!c.live) throw new Error('migrate.config.json needs "live" (the published site URL).');
  cached = c;
  return c;
}

export const SNAP_DIR = () => path.join(ROOT, config().snapshotsDir);
export const OUT_DIR = () => path.join(ROOT, config().outDir);

const probe = () => { try { return config().notFoundProbe; } catch { return DEFAULTS.notFoundProbe; } };

/** "/" -> "index", "/work/x" -> "work__x", "/pt-br/about" -> "pt-br__about", notFoundProbe -> "404" */
export const slugOf = (route) => {
  if (route === probe() || route === "404") return "404";
  return route === "/" ? "index" : route.replace(/^\//, "").replace(/\/$/, "").replace(/\//g, "__") || "index";
};
export const routeOf = (slug) => (slug === "404" ? probe() : slug === "index" ? "/" : "/" + slug.replace(/__/g, "/"));

/** Latest snapshot, unless pinned by env MIGRATE_SNAPSHOT or config "snapshot" (folder name or path). */
export function latestSnapshot() {
  const pin = process.env.MIGRATE_SNAPSHOT || (fs.existsSync(CONFIG_FILE) ? config().snapshot : null);
  if (pin) {
    const p = path.isAbsolute(pin) ? pin : fs.existsSync(path.join(ROOT, pin)) ? path.join(ROOT, pin) : path.join(SNAP_DIR(), pin);
    if (!fs.existsSync(p)) throw new Error(`Pinned snapshot not found: ${pin}`);
    return p;
  }
  const dir = SNAP_DIR();
  const dirs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}(T\d{4})?$/.test(d)).sort() : [];
  if (!dirs.length) throw new Error("No snapshot yet. Run: node tools/migrate/snapshot.mjs");
  return path.join(dir, dirs.at(-1));
}

export function readManifest(snapDir = latestSnapshot()) {
  return JSON.parse(fs.readFileSync(path.join(snapDir, "manifest.json"), "utf8"));
}

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export async function launch() {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless: true });
}

/** --name value | --flag (true) */
export function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

export const listArg = (name, def = []) => {
  const v = arg(name);
  return v === undefined || v === true ? def : String(v).split(",").map((s) => s.trim()).filter(Boolean);
};

export const numListArg = (name, def) => listArg(name).map(Number).filter(Boolean).length ? listArg(name).map(Number) : def;

/** Host matches an entry of assetHosts ("*.x.com" wildcards allowed). */
export function isMirroredHost(host, hosts = config().assetHosts) {
  const bare = (h) => h.replace(/^www\./, "");
  const liveHost = new URL(config().live).host;
  if (bare(host) === bare(liveHost)) return true;
  return hosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) || host === h.slice(2) : bare(host) === bare(h)));
}

/**
 * Local mirror path for a remote asset URL, the same function used by assets.mjs (download), tojsx.mjs (rewrite)
 * and measure.mjs (serve fonts to the live side when its host is down).
 *   https://cdn.x.com/a/b.png?w=800  ->  /_m/cdn.x.com/a/b__<hash8>.png   (query kept as a hash: variants stay distinct)
 *   /a/123/img.webp?width=800 (same origin)  ->  /_m/<live host>/a/123/img__<hash8>.webp
 */
export function mirrorPath(url) {
  const c = config();
  const u = new URL(url, c.live);
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
  if (p.endsWith("/")) p += "index";
  const ext = path.extname(p).replace(/[^A-Za-z0-9.]/g, "");
  const base = ext ? p.slice(0, -path.extname(p).length) : p;
  const safeBase = base.replace(/[^A-Za-z0-9._\-/@]/g, "_");
  // Hash the query (variants stay distinct) and, when characters were replaced, the original path (no collisions).
  const key = (u.search || "") + (safeBase !== base ? "|" + base : "");
  const q = key ? "__" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 8) : "";
  return `${c.mirrorPrefix}/${u.host}${safeBase}${q}${ext}`;
}

export const mirrorFile = (url) => path.join(ROOT, config().publicDir, mirrorPath(url));

/** Short, human summary line helpers: tools print little to the terminal and write details to files. */
export const pct = (n) => (n * 100).toFixed(2) + "%";

// ---------- Ycode / Next.js RSC payload helpers ----------

/** Decodes the RSC payload (self.__next_f.push) found in a Next.js page (Ycode, some Framer/WP headless). */
export function decodeFlight(html) {
  const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)<\/script>/g)].map((m) => m[1]);
  try {
    return JSON.parse('"' + parts.join("") + '"');
  } catch {
    return parts.map((p) => { try { return JSON.parse('"' + p + '"'); } catch { return ""; } }).join("");
  }
}

/** Splits the RSC payload into rows: "<id>:T<hex>,<N bytes of text>" (no trailing newline) or "<id>:<json>\n". */
export function flightRows(flight) {
  const buf = Buffer.from(flight, "utf8");
  const rows = [];
  let i = 0;
  while (i < buf.length) {
    while (i < buf.length && buf[i] === 10) i++;
    const colon = buf.indexOf(58, i);
    if (colon < 0) break;
    const id = buf.subarray(i, colon).toString();
    if (buf[colon + 1] === 84 && /^[0-9a-f]+,/.test(buf.subarray(colon + 2, colon + 14).toString())) {
      const comma = buf.indexOf(44, colon);
      const len = parseInt(buf.subarray(colon + 2, comma).toString(), 16);
      rows.push({ id, type: "T", text: buf.subarray(comma + 1, comma + 1 + len).toString("utf8") });
      i = comma + 1 + len;
    } else {
      let nl = buf.indexOf(10, colon);
      if (nl < 0) nl = buf.length;
      rows.push({ id, type: "row", text: buf.subarray(colon + 1, nl).toString("utf8") });
      i = nl + 1;
    }
  }
  return rows;
}

/** Closes the bracket/brace opened at t[i], string-aware. */
export function matchBracket(t, i) {
  let d = 0, ins = false, esc = false;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (ins) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') ins = false; }
    else if (c === '"') ins = true;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") { d--; if (d === 0) return j + 1; }
  }
  return -1;
}
