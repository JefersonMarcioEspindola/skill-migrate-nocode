// Streaming parser for MySQL dumps (mysqldump, phpMyAdmin, WP-CLI `wp db export`, most backup plugins).
// Reads the file in chunks and emits rows of INSERT/REPLACE statements one tuple at a time, so multi-GB dumps
// with huge extended inserts never sit in memory. Handles: '…' and "…" strings with backslash escapes and '' doubling,
// NULL, numbers, 0x… / X'…' hex, _binary/_utf8mb4 introducers, -- # /* */ comments, /*!40101 … */ conditionals,
// DELIMITER changes, column lists in INSERT or taken from CREATE TABLE. UTF-8 (utf8mb4) safe across chunk boundaries.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const NEED = Symbol("need-more-data");

/**
 * scanDump(file, { wantRows(table) => bool, onCreate(table, columns), onRow(table, rowObject), onProgress(bytes) })
 * Resolves with { tables: Map(name -> { columns, rows }), bytes }.
 */
export async function scanDump(file, { wantRows = () => true, onCreate, onRow, onProgress, chunkSize = 1 << 22 } = {}) {
  const total = fs.statSync(file).size;
  const stream = fs.createReadStream(file, { highWaterMark: chunkSize });
  const it = stream[Symbol.asyncIterator]();
  const decoder = new StringDecoder("utf8");
  const tables = new Map();
  let buf = "", pos = 0, unit = 0, eof = false, readBytes = 0, delimiter = ";";
  let mode = "top", table = null, columns = null, emit = false, tinfo = null;

  async function more() {
    const r = await it.next();
    buf = buf.slice(unit);
    pos = unit = 0;
    if (r.done) { eof = true; buf += decoder.end(); return false; }
    readBytes += r.value.length;
    buf += decoder.write(r.value);
    onProgress?.(readBytes, total);
    return true;
  }
  const need = () => { if (!eof) throw NEED; };

  function skipSpaceAndComments() {
    for (;;) {
      while (pos < buf.length && /\s/.test(buf[pos])) pos++;
      if (pos >= buf.length) return need();
      const c = buf[pos], d = buf[pos + 1];
      if ((c === "-" && d === "-" && (/\s/.test(buf[pos + 2] ?? "") || pos + 2 >= buf.length)) || c === "#") {
        const nl = buf.indexOf("\n", pos);
        if (nl < 0) { need(); pos = buf.length; return; }
        pos = nl + 1;
      } else if (c === "/" && d === "*") {
        const end = buf.indexOf("*/", pos + 2);
        if (end < 0) { need(); pos = buf.length; return; }
        pos = end + 2;
        while (pos < buf.length && /[ \t]/.test(buf[pos])) pos++;
        if (buf[pos] === ";") pos++;
      } else if (pos + 1 >= buf.length && !eof) return need();
      else return;
    }
  }

  // Reads a quoted string starting at pos (buf[pos] is the quote). build=false only skips.
  function readString(build) {
    const q = buf[pos];
    let i = pos + 1, out = build ? [] : null, segStart = i;
    for (;;) {
      const bs = buf.indexOf("\\", i), qq = buf.indexOf(q, i);
      if (qq < 0) { need(); throw new Error("unterminated string at end of dump"); }
      if (bs >= 0 && bs < qq) {
        if (bs + 1 >= buf.length) need();
        if (build) {
          out.push(buf.slice(segStart, bs));
          const e = buf[bs + 1];
          out.push(e === "0" ? "\0" : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "b" ? "\b" : e === "Z" ? "\x1a" : e === "%" ? "\\%" : e === "_" ? "\\_" : e);
        }
        i = segStart = bs + 2;
        continue;
      }
      if (buf[qq + 1] === q) { if (build) out.push(buf.slice(segStart, qq), q); i = segStart = qq + 2; continue; }
      if (qq + 1 >= buf.length) need();
      if (build) out.push(buf.slice(segStart, qq));
      pos = qq + 1;
      return build ? out.join("") : null;
    }
  }

  function readValue(build) {
    const c = buf[pos];
    if (c === "'" || c === '"') return readString(build);
    // introducers: _binary'…' _utf8mb4'…' N'…' X'…' b'…'
    const intro = /^(_[a-z0-9]+\s*|N(?=')|[Xx](?=')|[Bb](?='))/.exec(buf.slice(pos, pos + 16));
    if (intro && buf[pos + intro[0].length] === "'") {
      const kind = intro[0].trim();
      pos += intro[0].length;
      const s = readString(build);
      if (!build) return null;
      if (kind === "X" || kind === "x") return Buffer.from(s, "hex").toString("utf8");
      return s;
    }
    let j = pos;
    while (j < buf.length && buf[j] !== "," && buf[j] !== ")" && !/\s/.test(buf[j])) j++;
    if (j >= buf.length) need();
    const tok = buf.slice(pos, j);
    pos = j;
    if (!build) return null;
    if (/^NULL$/i.test(tok)) return null;
    if (/^0x[0-9a-f]*$/i.test(tok)) return Buffer.from(tok.slice(2), "hex").toString("utf8");
    return tok; // numbers stay strings (no precision loss on BIGINT)
  }

  function readTuple() {
    pos++; // (
    const vals = [];
    for (;;) {
      while (pos < buf.length && /\s/.test(buf[pos])) pos++;
      if (pos >= buf.length) need();
      if (buf[pos] === ")") { pos++; return vals; }
      vals.push(readValue(emit));
      while (pos < buf.length && /\s/.test(buf[pos])) pos++;
      if (pos >= buf.length) need();
      if (buf[pos] === ",") { pos++; continue; }
      if (buf[pos] === ")") { pos++; return vals; }
      throw new Error(`unexpected "${buf.slice(pos, pos + 20)}" in VALUES of ${table}`);
    }
  }

  // Reads a whole non-INSERT statement up to the delimiter (outside quotes/comments).
  function readStatement() {
    let i = pos;
    for (;;) {
      if (i >= buf.length) { need(); const s = buf.slice(pos); pos = buf.length; return s; }
      const c = buf[i];
      if (c === "'" || c === '"' || c === "`") {
        const end = buf.indexOf(c, i + 1);
        if (end < 0) { need(); i = buf.length; continue; }
        let k = end; let bs = 0; while (c !== "`" && buf[k - 1 - bs] === "\\") bs++;
        i = bs % 2 ? end : end + 1;
        if (bs % 2) { i = end + 1; continue; }
        continue;
      }
      if (c === "-" && buf[i + 1] === "-") { const nl = buf.indexOf("\n", i); if (nl < 0) { need(); i = buf.length; continue; } i = nl + 1; continue; }
      if (c === "/" && buf[i + 1] === "*" && buf[i + 2] !== "!") { const e = buf.indexOf("*/", i + 2); if (e < 0) { need(); i = buf.length; continue; } i = e + 2; continue; }
      if (buf.startsWith(delimiter, i)) { const s = buf.slice(pos, i); pos = i + delimiter.length; return s; }
      i++;
    }
  }

  const unq = (s) => s.replace(/^`|`$/g, "").replace(/``/g, "`");
  const tableName = (raw) => unq(raw.includes("`.`") ? raw.split("`.`").pop() : raw.includes(".") && !raw.includes("`") ? raw.split(".").pop() : raw);

  function onStatement(s) {
    const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`[^`]+`\.)?`[^`]+`|[\w$.]+)\s*\(/i.exec(s);
    if (!m) return;
    const name = tableName(m[1]);
    const cols = [];
    for (const line of s.slice(m[0].length).split("\n")) {
      const c = /^\s*`((?:[^`]|``)+)`\s+[a-z]/i.exec(line) || /^\s*([A-Za-z_][\w$]*)\s+(?:big|tiny|small|medium)?(?:int|varchar|char|text|longtext|mediumtext|datetime|date|timestamp|decimal|float|double|blob|longblob|enum|json|bit)/i.exec(line);
      if (c && !/^\s*(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FULLTEXT|SPATIAL)\b/i.test(line)) cols.push(c[1].replace(/``/g, "`"));
    }
    const t = tables.get(name) || { columns: [], rows: 0 };
    t.columns = cols;
    tables.set(name, t);
    onCreate?.(name, cols);
  }

  for (;;) {
    try {
      unit = pos;
      if (mode === "top") {
        skipSpaceAndComments();
        if (pos >= buf.length) { if (eof) break; need(); }
        unit = pos;
        if (/^DELIMITER\s/i.test(buf.slice(pos, pos + 10))) {
          const nl = buf.indexOf("\n", pos);
          if (nl < 0) need();
          delimiter = buf.slice(pos + 10, nl < 0 ? buf.length : nl).trim() || ";";
          pos = nl < 0 ? buf.length : nl + 1;
          continue;
        }
        if (buf.length - pos < 256 && !eof) need();
        if (/^(INSERT|REPLACE)\b/i.test(buf.slice(pos, pos + 7))) {
          const head = buf.slice(pos, pos + 65536);
          const m = /^(?:INSERT|REPLACE)\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY)\s+)?(?:IGNORE\s+)?INTO\s+((?:`[^`]+`\.)?`[^`]+`|[\w$.]+)\s*(?:\(([^)]*)\))?\s*VALUES?\s*/i.exec(head);
          if (!m) { if (head.length < 65536) need(); readStatement(); continue; }
          table = tableName(m[1]);
          tinfo = tables.get(table) || { columns: [], rows: 0 };
          tables.set(table, tinfo);
          columns = m[2] ? m[2].split(",").map((c) => unq(c.trim())) : tinfo.columns;
          emit = !!wantRows(table);
          pos += m[0].length;
          mode = "values";
        } else {
          onStatement(readStatement());
        }
      } else {
        while (pos < buf.length && /\s/.test(buf[pos])) pos++;
        if (pos >= buf.length) { if (eof) break; need(); }
        const c = buf[pos];
        if (c === "(") {
          const vals = readTuple();
          tinfo.rows++;
          if (emit && onRow) {
            const row = {};
            for (let i = 0; i < vals.length; i++) row[columns[i] ?? `c${i}`] = vals[i];
            onRow(table, row);
          }
        } else if (c === ",") pos++;
        else if (buf.startsWith(delimiter, pos)) { pos += delimiter.length; mode = "top"; }
        else { readStatement(); mode = "top"; } // ON DUPLICATE KEY UPDATE … etc.
      }
    } catch (e) {
      if (e !== NEED) throw e;
      pos = unit;
      if (!(await more()) && unit >= buf.length) break;
    }
  }
  return { tables, bytes: readBytes };
}
