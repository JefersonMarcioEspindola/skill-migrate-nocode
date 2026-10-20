// Minimal PHP unserialize() for WordPress meta/options. Works on UTF-8 BYTES (s:N counts bytes, like PHP).
// Arrays with keys 0..n-1 become JS arrays, others plain objects. Objects become { __class, ...props }.
// Lenient: when a string length is wrong (charset conversion or naive search-replace broke it), it looks for the
// real terminator and counts the repair in `stats.repaired`.
export const stats = { repaired: 0, failed: 0 };

export function isSerialized(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s === "N;" || s === "b:0;" || s === "b:1;") return true;
  return /^(a|O|C):\d+:/.test(s) ? /[;}]$/.test(s) : /^(s:\d+:".*";|i:-?\d+;|d:[^;]+;|b:[01];)$/s.test(s);
}

export function unserialize(input) {
  const b = Buffer.from(String(input), "utf8");
  let p = 0;
  const fail = (msg) => { throw new Error(`unserialize: ${msg} at byte ${p}`); };
  const readUntil = (ch) => {
    const i = b.indexOf(ch, p);
    if (i < 0) fail(`expected "${ch}"`);
    const s = b.toString("latin1", p, i);
    p = i + 1;
    return s;
  };
  const expect = (ch) => { if (b[p] !== ch.charCodeAt(0)) fail(`expected "${ch}"`); p++; };
  const NEXT = new Set([..."sibdaONCrRE}"].map((c) => c.charCodeAt(0)));

  function str(len) {
    expect('"');
    let end = p + len;
    if (!(b[end] === 0x22 && b[end + 1] === 0x3b)) {
      // repair: find '";' followed by something that can start the next token
      let k = p, found = -1;
      while ((k = b.indexOf('";', k)) >= 0) { if (k + 2 >= b.length || NEXT.has(b[k + 2])) { found = k; break; } k++; }
      if (found < 0) fail("broken string length");
      end = found;
      stats.repaired++;
    }
    const s = b.toString("utf8", p, end);
    p = end + 2;
    return s;
  }

  function value() {
    const t = String.fromCharCode(b[p]);
    p += 2; // "x:" or "N;"
    switch (t) {
      case "N": return null;
      case "b": return readUntil(";") === "1";
      case "i": { const s = readUntil(";"); const n = Number(s); return Number.isSafeInteger(n) ? n : s; }
      case "d": { const s = readUntil(";"); return s === "INF" ? Infinity : s === "-INF" ? -Infinity : s === "NAN" ? NaN : Number(s); }
      case "s": return str(Number(readUntil(":")));
      case "S": { // escaped string (\xx hex)
        const len = Number(readUntil(":")); expect('"');
        let out = [], n = 0;
        while (n < len) { if (b[p] === 0x5c) { out.push(parseInt(b.toString("latin1", p + 1, p + 3), 16)); p += 3; } else out.push(b[p++]); n++; }
        p += 2; return Buffer.from(out).toString("utf8");
      }
      case "a": {
        const n = Number(readUntil(":")); expect("{");
        const keys = [], vals = [];
        for (let i = 0; i < n; i++) { keys.push(value()); vals.push(value()); }
        expect("}");
        if (keys.every((k, i) => k === i)) return vals;
        return Object.fromEntries(keys.map((k, i) => [String(k), vals[i]]));
      }
      case "O": {
        const len = Number(readUntil(":"));
        expect('"'); const cls = b.toString("utf8", p, p + len); p += len; expect('"'); expect(":");
        const n = Number(readUntil(":")); expect("{");
        const o = { __class: cls };
        for (let i = 0; i < n; i++) { const k = String(value()).replace(/^\0[^\0]*\0/, ""); o[k] = value(); }
        expect("}");
        return o;
      }
      case "C": {
        const len = Number(readUntil(":"));
        expect('"'); const cls = b.toString("utf8", p, p + len); p += len; expect('"'); expect(":");
        const n = Number(readUntil(":")); expect("{");
        const data = b.toString("utf8", p, p + n); p += n; expect("}");
        return { __class: cls, __serialized: data };
      }
      case "E": { const len = Number(readUntil(":")); expect('"'); const s = b.toString("utf8", p, p + len); p += len + 2; return { __enum: s }; }
      case "r": case "R": return { __ref: Number(readUntil(";")) };
      default: fail(`unknown type "${t}"`);
    }
  }
  const v = value();
  return v;
}

/** WordPress maybe_unserialize(): returns the decoded value, or the input when it is not (valid) serialized data. */
export function maybeUnserialize(v) {
  if (!isSerialized(v)) return v;
  try {
    let out = unserialize(v.trim());
    if (isSerialized(out)) { try { out = unserialize(out.trim()); } catch {} } // double-serialized
    return out;
  } catch {
    stats.failed++;
    return v;
  }
}
