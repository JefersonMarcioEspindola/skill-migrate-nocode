// Side-by-side crop (live | local) of the same vertical band, from the full-page captures of the last measure.
// Usage: node tools/migrate/crop.mjs --route / --width 1440 --y0 0 [--y1 900] [--local-y0 N] [--measure]
//   --measure      runs measure first (also done automatically when no capture exists)
//   --local-y0 N   start the local band elsewhere (e.g. when content above is taller on one side)
// Output: <outDir>/<slug>/<width>/crop-<y0>-<y1>.png  (left = live, right = local, red divider)
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { OUT_DIR, slugOf, arg } from "./lib/common.mjs";
import { isMain } from "./lib/compare.mjs";
import { measure } from "./measure.mjs";

/** Builds the crop PNG buffer from two full-page PNG buffers. */
export function cropPair(liveBuf, localBuf, y0, y1, localY0 = y0, gap = 16) {
  const A = PNG.sync.read(liveBuf), B = PNG.sync.read(localBuf);
  const h = Math.max(1, Math.min(y1 - y0, A.height - y0, B.height - localY0));
  const out = new PNG({ width: A.width + gap + B.width, height: h });
  out.data.fill(255);
  if (A.height > y0) PNG.bitblt(A, out, 0, y0, A.width, Math.min(h, A.height - y0), 0, 0);
  if (B.height > localY0) PNG.bitblt(B, out, 0, localY0, B.width, Math.min(h, B.height - localY0), A.width + gap, 0);
  for (let y = 0; y < h; y++) for (let x = A.width; x < A.width + gap; x++) { const i = (y * out.width + x) * 4; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255; }
  return { png: PNG.sync.write(out), h };
}

if (isMain(import.meta.url)) {
  const route = arg("route", "/");
  const width = Number(arg("width", 1440));
  const y0 = Number(arg("y0", 0));
  const y1 = Number(arg("y1", y0 + 900));
  const localY0 = Number(arg("local-y0", y0));
  const dir = path.join(OUT_DIR(), slugOf(route), String(width));
  if (arg("measure") || !fs.existsSync(path.join(dir, "live.png")) || !fs.existsSync(path.join(dir, "local.png"))) await measure({ route, width, outDir: dir });
  const { png, h } = cropPair(fs.readFileSync(path.join(dir, "live.png")), fs.readFileSync(path.join(dir, "local.png")), y0, y1, localY0);
  const file = path.join(dir, `crop-${y0}-${y0 + h}.png`);
  fs.writeFileSync(file, png);
  console.log(`crop: ${path.relative(process.cwd(), file)} (left = live, right = local)`);
}
