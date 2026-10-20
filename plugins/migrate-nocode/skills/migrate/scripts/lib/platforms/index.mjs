// Platform registry: detection scores and the per-platform fact extractors.
import * as ycode from "./ycode.mjs";
import * as webflow from "./webflow.mjs";
import * as framer from "./framer.mjs";
import * as wordpress from "./wordpress.mjs";

export const PLATFORMS = { ycode, webflow, framer, wordpress };

/** Scores every platform on raw HTML (+ response headers). Returns { platform, score, results[] } ("other" if none). */
export function detectPlatform(html, url, headers = {}) {
  const results = Object.entries(PLATFORMS).map(([name, m]) => {
    const evidence = m.evidence(html, url, headers);
    return { name, score: evidence.reduce((a, e) => a + e.weight, 0), detected: m.detect(html, url, headers), evidence };
  }).sort((a, b) => b.score - a.score);
  const best = results.find((r) => r.detected);
  return { platform: best ? best.name : "other", score: best?.score || 0, results };
}

export const platformModule = (name) => PLATFORMS[name] || null;
