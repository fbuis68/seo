import { gunzipSync } from 'zlib';

/**
 * Lecteur de sauvegarde mysqldump / mariadb-dump (base MCDF).
 * Lit uniquement les instructions CREATE TABLE (noms et types de colonnes) et INSERT INTO ;
 * tout le reste (SET, LOCK, commentaires, vues, procédures) est ignoré, rien n'est exécuté.
 * Gère les insertions étendues, les échappements MySQL, _binary '…', 0x… (--hex-blob) et b'…' (BIT).
 */
export type DumpValue = string | Buffer | null;
export interface DumpTable { name: string; columns: string[]; types: string[]; rows: DumpValue[][] }

const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
export const looksLikeDump = (b: Buffer) => {
  const head = (isGzip(b) ? gunzipSync(b).subarray(0, 4096) : b.subarray(0, 4096)).toString('utf8');
  return /(MariaDB|MySQL) dump|^\s*(CREATE TABLE|INSERT INTO|DROP TABLE)/im.test(head);
};

const BQ = 0x60, SQ = 0x27, BS = 0x5c, LP = 0x28, RP = 0x29, COMMA = 0x2c, SEMI = 0x3b;
const ESC: Record<number, number> = { 0x30: 0, 0x27: 0x27, 0x22: 0x22, 0x62: 8, 0x6e: 10, 0x72: 13, 0x74: 9, 0x5a: 26, 0x5c: 0x5c };

export function parseDump(input: Buffer, opts: { only?: Set<string> } = {}): Map<string, DumpTable> {
  const buf = isGzip(input) ? gunzipSync(input) : input;
  const tables = new Map<string, DumpTable>();
  const n = buf.length;
  let i = 0;

  const skipWs = () => { while (i < n && (buf[i] === 32 || buf[i] === 9 || buf[i] === 10 || buf[i] === 13)) i++; };
  const startsWith = (s: string) => {
    for (let k = 0; k < s.length; k++) {
      const c = buf[i + k];
      if (c === undefined) return false;
      const a = s.charCodeAt(k);
      if (c !== a && !(a >= 65 && a <= 90 && c === a + 32)) return false;
    }
    return true;
  };
  const lineEnd = () => { while (i < n && buf[i] !== 10) i++; };
  const ident = () => { // `nom`
    skipWs();
    if (buf[i] !== BQ) return null;
    const s = ++i;
    while (i < n && buf[i] !== BQ) i++;
    return buf.toString('utf8', s, i++);
  };
  /** Chaîne entre apostrophes → octets décodés (échappements MySQL). */
  const quoted = (): Buffer => {
    i++; // '
    const parts: Buffer[] = [];
    let s = i;
    while (i < n) {
      const c = buf[i];
      if (c === BS) {
        parts.push(buf.subarray(s, i));
        const e = buf[i + 1];
        if (e === 0x25 || e === 0x5f) parts.push(buf.subarray(i, i + 2)); // \% et \_ conservés tels quels
        else parts.push(Buffer.from([ESC[e] ?? e]));
        i += 2; s = i; continue;
      }
      if (c === SQ) {
        if (buf[i + 1] === SQ) { parts.push(buf.subarray(s, i + 1)); i += 2; s = i; continue; }
        parts.push(buf.subarray(s, i)); i++;
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
      }
      i++;
    }
    throw new Error('Chaîne non terminée dans la sauvegarde');
  };
  const value = (): DumpValue | { bits: string } => {
    skipWs();
    const c = buf[i];
    if (c === SQ) return quoted();
    if (startsWith('NULL')) { i += 4; return null; }
    if (startsWith("_binary '")) { i += 8; return quoted(); }
    if (startsWith("b'")) { i += 2; const s = i; while (buf[i] !== SQ) i++; const bits = buf.toString('latin1', s, i++); return { bits }; }
    if (startsWith("x'")) { i += 2; const s = i; while (buf[i] !== SQ) i++; return Buffer.from(buf.toString('latin1', s, i++), 'hex'); }
    if (startsWith('0x')) { i += 2; const s = i; while (i < n && /[0-9a-f]/i.test(String.fromCharCode(buf[i]))) i++; return Buffer.from(buf.toString('latin1', s, i), 'hex'); }
    const s = i;
    while (i < n && buf[i] !== COMMA && buf[i] !== RP) i++;
    return buf.toString('latin1', s, i).trim();
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (buf[i] === 0x2d && buf[i + 1] === 0x2d) { lineEnd(); continue; }      // -- commentaire
    if (buf[i] === 0x2f && buf[i + 1] === 0x2a) {                            // /* … */ ou /*! … */
      const end = buf.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue;
    }
    if (startsWith('CREATE TABLE')) {
      i += 12; skipWs();
      if (startsWith('IF NOT EXISTS')) i += 13;
      const name = ident()!;
      const end = buf.indexOf(';\n', i);
      const body = buf.toString('utf8', i, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      const columns: string[] = [], types: string[] = [];
      for (const line of body.split('\n')) {
        const m = /^\s*`([^`]+)`\s+([a-z]+(?:\([^)]*\))?)/i.exec(line);
        if (m) { columns.push(m[1]); types.push(m[2].toLowerCase()); }
      }
      if (!opts.only || opts.only.has(name.toLowerCase())) tables.set(name.toLowerCase(), { name, columns, types, rows: [] });
      continue;
    }
    if (startsWith('INSERT INTO') || startsWith('INSERT IGNORE INTO') || startsWith('REPLACE INTO')) {
      i += startsWith('INSERT IGNORE INTO') ? 18 : startsWith('REPLACE INTO') ? 12 : 11;
      const name = ident()!;
      const t = tables.get(name.toLowerCase());
      skipWs();
      let order: number[] | null = null;
      if (buf[i] === LP) { // liste de colonnes explicite
        i++;
        const cols: string[] = [];
        for (;;) { const c = ident(); if (c == null) break; cols.push(c); skipWs(); if (buf[i] === COMMA) i++; }
        skipWs(); i++; // )
        if (t) order = cols.map((c) => t.columns.findIndex((x) => x.toLowerCase() === c.toLowerCase()));
      }
      skipWs();
      if (!startsWith('VALUES')) { const e = buf.indexOf(';\n', i); i = e < 0 ? n : e + 1; continue; }
      i += 6;
      if (!t) { // table hors périmètre : saut rapide en respectant les chaînes
        for (;;) {
          skipWs();
          if (buf[i] === SEMI || i >= n) { i++; break; }
          if (buf[i] === SQ) { quoted(); continue; }
          i++;
        }
        continue;
      }
      const bitCols = new Set(t.types.map((ty, k) => (ty.startsWith('bit') ? k : -1)).filter((k) => k >= 0));
      for (;;) {
        skipWs();
        if (buf[i] === SEMI) { i++; break; }
        if (buf[i] === COMMA) { i++; continue; }
        if (buf[i] !== LP) throw new Error(`Instruction INSERT illisible (${name})`);
        i++;
        const raw: (DumpValue | { bits: string })[] = [];
        for (;;) {
          raw.push(value());
          skipWs();
          if (buf[i] === COMMA) { i++; continue; }
          if (buf[i] === RP) { i++; break; }
          throw new Error(`Ligne INSERT illisible (${name})`);
        }
        const row: DumpValue[] = new Array(t.columns.length).fill(null);
        raw.forEach((v, k) => {
          const col = order ? order[k] : k;
          if (col < 0 || col >= row.length) return;
          row[col] = decode(v, t.types[col], bitCols.has(col));
        });
        t.rows.push(row);
      }
      continue;
    }
    // Autre instruction (DROP, LOCK, SET…) : jusqu'au point-virgule de fin.
    const e = buf.indexOf(';', i);
    i = e < 0 ? n : e + 1;
  }
  return tables;
}

const BINARY = /^(tiny|medium|long)?blob|^binary|^varbinary/;
function decode(v: DumpValue | { bits: string }, type: string, isBit: boolean): DumpValue {
  if (v === null) return null;
  if (typeof v === 'object' && !Buffer.isBuffer(v)) return String(parseInt(v.bits || '0', 2));
  if (isBit) {
    if (Buffer.isBuffer(v)) return String(v.reduce((a, b) => a * 256 + b, 0));
    return v;
  }
  if (Buffer.isBuffer(v)) return BINARY.test(type) ? v : v.toString('utf8');
  return v;
}

/** Ligne → objet {COLONNE: valeur} (noms en majuscules, comme dans MCDF). */
export function rowsOf(t: DumpTable | undefined): Record<string, DumpValue>[] {
  if (!t) return [];
  const cols = t.columns.map((c) => c.toUpperCase());
  return t.rows.map((r) => { const o: Record<string, DumpValue> = {}; cols.forEach((c, k) => { o[c] = r[k]; }); return o; });
}
