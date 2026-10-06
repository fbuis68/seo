import { readZip } from './archive';

export interface Table { name: string; columns: string[]; rows: Record<string, string>[] }

/** Décodage : UTF-8 si valide, sinon Windows-1252 (exports Excel français). */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(b), encoding: 'windows-1252' };
  }
}

/** CSV RFC 4180, séparateur détecté (; , tab |), guillemets et retours ligne dans les champs. */
export function parseCsv(text: string, name = 'table'): Table {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', ',', '\t', '|'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const records: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) records.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) records.push(row);
  const columns = (records.shift() ?? []).map((h) => h.trim());
  return { name, columns, rows: records.map((r) => Object.fromEntries(columns.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Décodage des seules entités prédéfinies/numériques : aucune entité externe résolue. */
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e.toLowerCase()]);

function assertNoDoctype(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Object.assign(new Error('XML avec DOCTYPE/ENTITY refusé (entités externes interdites).'), { code: 'xml_doctype' });
}

const colIndex = (ref: string) => ref.replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/**
 * Lecteur XLSX minimal : valeurs en cache uniquement (formules jamais exécutées ;
 * formule sans valeur en cache = cellule vide signalée par l'appelant).
 */
export async function parseXlsx(buf: Buffer, baseName: string): Promise<Table[]> {
  const { entries, rejections } = await readZip(buf, { maxEntries: 2000, maxTotalUncompressed: 500 * 1024 ** 2, maxEntrySize: 200 * 1024 ** 2, maxRatio: 200 });
  if (rejections.length) throw Object.assign(new Error(rejections[0].message), { code: rejections[0].code });
  const get = (p: string) => entries.find((e) => e.path === p)?.data?.toString('utf8');
  if (entries.some((e) => /vbaProject\.bin$/i.test(e.path))) throw Object.assign(new Error('Classeur contenant des macros refusé.'), { code: 'macro_file' });
  const shared: string[] = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) {
    assertNoDoctype(sst);
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(unxml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  }
  const wb = get('xl/workbook.xml') ?? '';
  assertNoDoctype(wb);
  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].map((m) => {
    const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]*)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]*)"[^>]*Id="${m[2]}"`).exec(rels)?.[1];
    return { name: unxml(m[1]), path: target ? `xl/${target.replace(/^\/?xl\//, '')}` : '' };
  });
  const tables: Table[] = [];
  for (const sh of sheets) {
    const xml = get(sh.path);
    if (!xml) continue;
    assertNoDoctype(xml);
    const grid: string[][] = [];
    for (const r of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of r.match(/<c [^>]*?(\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = /r="([A-Z]+\d+)"/.exec(c)?.[1];
        const t = /t="([^"]+)"/.exec(c)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c)?.[1];
        let val = '';
        if (t === 's' && v != null) val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr' && inline != null) val = unxml(inline);
        else if (v != null) val = unxml(v);
        const idx = ref ? colIndex(ref) : cells.length;
        cells[idx] = val;
      }
      grid.push(Array.from(cells, (x) => x ?? ''));
    }
    const header = (grid.shift() ?? []).map((h) => h.trim());
    tables.push({
      name: sheets.length > 1 ? `${baseName}#${sh.name}` : baseName, columns: header,
      rows: grid.filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))),
    });
  }
  return tables;
}

export async function parseTableFile(path: string, data: Buffer): Promise<Table[]> {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'xlsx') return parseXlsx(data, path);
  if (ext === 'json') {
    const v = JSON.parse(decodeText(data).text);
    const rows: any[] = Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : [];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
    return [{ name: path, columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] == null ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])]))) }];
  }
  if (ext === 'xml') { assertNoDoctype(decodeText(data).text); return []; }
  return [parseCsv(decodeText(data).text, path)];
}
