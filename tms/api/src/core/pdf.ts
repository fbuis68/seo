/**
 * Générateur PDF minimal sans dépendance (texte, titres, tableaux simples, multi-pages).
 * Polices standard Helvetica en WinAnsiEncoding : accents français pris en charge.
 */
export type Block =
  | { type: 'title'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; bold?: boolean; size?: number }
  | { type: 'spacer'; height?: number }
  | { type: 'table'; columns: { label: string; width: number; align?: 'left' | 'right' }[]; rows: string[][] }
  | { type: 'signature'; labels: string[] };

const WIN1252: Record<number, number> = { 0x20ac: 0x80, 0x2019: 0x92, 0x2018: 0x91, 0x201c: 0x93, 0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x2026: 0x85, 0x0153: 0x9c, 0x0152: 0x8c, 0x00a0: 0x20, 0x202f: 0x20 };
function encode(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const b = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : WIN1252[c] ?? 0x3f;
    const chr = String.fromCharCode(b);
    out += chr === '(' || chr === ')' || chr === '\\' ? '\\' + chr : chr;
  }
  return out;
}

// Largeur approximative Helvetica (moyenne) pour le retour à la ligne.
const charWidth = (size: number, bold?: boolean) => size * (bold ? 0.56 : 0.52);
function wrap(text: string, maxWidth: number, size: number, bold?: boolean): string[] {
  const maxChars = Math.max(10, Math.floor(maxWidth / charWidth(size, bold)));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((cur + ' ' + word).trim().length > maxChars) { if (cur) lines.push(cur); cur = word.length > maxChars ? word.slice(0, maxChars) : word; }
      else cur = (cur + ' ' + word).trim();
    }
    lines.push(cur);
  }
  return lines;
}

import type { PdfLogo } from './branding';

export function renderPdf(blocks: Block[], meta: { title: string; footer?: string; logo?: PdfLogo; color?: [number, number, number] }): Buffer {
  const W = 595, H = 842, M = 50;
  // Logo en haut à droite de chaque page (hauteur max. 34 pt, largeur max. 150 pt) ; contenu décalé d'autant.
  const logo = meta.logo;
  const scale = logo ? Math.min(34 / logo.height, 150 / logo.width) : 0;
  const lw = logo ? logo.width * scale : 0; const lh = logo ? logo.height * scale : 0;
  const top = H - M - (logo ? 18 : 0);
  const rgb = meta.color ? `${meta.color.map((c) => c.toFixed(3)).join(' ')} rg` : '';
  const pages: string[] = [];
  let ops: string[] = [];
  let y = top;
  const newPage = () => { pages.push(ops.join('\n')); ops = []; y = top; };
  const ensure = (h: number) => { if (y - h < M + 30) newPage(); };
  const text = (x: number, size: number, s: string, bold = false, color = false) => ops.push(`${color && rgb ? `${rgb} ` : ''}BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${encode(s)}) Tj ET${color && rgb ? ' 0 g' : ''}`);

  for (const b of blocks) {
    if (b.type === 'title' || b.type === 'heading' || b.type === 'text') {
      const size = b.type === 'title' ? 16 : b.type === 'heading' ? 12 : b.size ?? 10;
      const bold = b.type !== 'text' || !!b.bold;
      if (b.type !== 'text') y -= 6;
      for (const line of wrap(b.text, W - 2 * M, size, bold)) { ensure(size + 4); text(M, size, line, bold, b.type !== 'text'); y -= size + 4; }
      if (b.type === 'title') y -= 6;
    } else if (b.type === 'spacer') {
      y -= b.height ?? 10;
    } else if (b.type === 'table') {
      const total = b.columns.reduce((a, c) => a + c.width, 0);
      const widths = b.columns.map((c) => (c.width / total) * (W - 2 * M));
      const drawRow = (cells: string[], bold: boolean) => {
        const wrapped = cells.map((c, i) => wrap(c ?? '', widths[i] - 6, 9, bold));
        const h = Math.max(...wrapped.map((w) => w.length)) * 12 + 4;
        ensure(h);
        let x = M;
        const rowTop = y;
        wrapped.forEach((lines, i) => {
          lines.forEach((l, j) => {
            const col = b.columns[i];
            const tx = col.align === 'right' ? x + widths[i] - 3 - l.length * charWidth(9, bold) : x + 3;
            ops.push(`BT /${bold ? 'F2' : 'F1'} 9 Tf ${tx.toFixed(1)} ${(rowTop - 10 - j * 12).toFixed(1)} Td (${encode(l)}) Tj ET`);
          });
          x += widths[i];
        });
        ops.push(`${bold && meta.color ? `${meta.color.map((c) => c.toFixed(3)).join(' ')} RG ` : ''}0.6 w ${M} ${(rowTop - h + 2).toFixed(1)} m ${W - M} ${(rowTop - h + 2).toFixed(1)} l S${bold && meta.color ? ' 0 G' : ''}`);
        y -= h;
      };
      drawRow(b.columns.map((c) => c.label), true);
      b.rows.forEach((r) => drawRow(r, false));
      y -= 6;
    } else if (b.type === 'signature') {
      ensure(80);
      const w = (W - 2 * M) / b.labels.length;
      b.labels.forEach((l, i) => {
        ops.push(`BT /F1 9 Tf ${(M + i * w).toFixed(1)} ${y.toFixed(1)} Td (${encode(l)}) Tj ET`);
        ops.push(`0.5 w ${(M + i * w).toFixed(1)} ${(y - 60).toFixed(1)} ${(w - 20).toFixed(1)} 50 re S`);
      });
      y -= 80;
    }
  }
  pages.push(ops.join('\n'));

  // Pied de page numéroté.
  const logoOps = logo ? `q ${lw.toFixed(2)} 0 0 ${lh.toFixed(2)} ${(W - M - lw).toFixed(2)} ${(H - 22 - lh).toFixed(2)} cm /Im1 Do Q\n` : '';
  const contents = pages.map((p, i) => `${logoOps}${p}\nBT /F1 8 Tf ${M} 25 Td (${encode(`${meta.footer ?? meta.title} — page ${i + 1}/${pages.length}`)}) Tj ET`);
  const objs: string[] = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const pageIds = contents.map((_, i) => 5 + i * 2);
  objs.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${contents.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const imgId = 5 + contents.length * 2;
  contents.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${logo ? ` /XObject << /Im1 ${imgId} 0 R >>` : ''} >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream`);
  });
  if (logo) {
    objs.push(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /${logo.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.data.length} >>\nstream\n${logo.data.toString('latin1')}\nendstream`);
  }
  objs.push(`<< /Title (${encode(meta.title)}) /Producer (TMS) >>`);
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
