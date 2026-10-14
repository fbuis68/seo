import { Tx, one } from './db';
import { badRequest } from './errors';

/** Logo prêt pour les PDF : JPEG (DCTDecode) avec dimensions et nombre de composantes. */
export interface PdfLogo { data: Buffer; width: number; height: number; components: 1 | 3 }
export interface DocBranding { logo?: PdfLogo; color?: [number, number, number] }

/** Dimensions et composantes d'un JPEG (segment SOF) ; refuse tout autre contenu. */
export function inspectJpeg(buf: Buffer): { width: number; height: number; components: 1 | 3 } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw badRequest('invalid_logo', 'Logo : JPEG attendu pour les documents.', 'jpeg');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 hors DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = buf.readUInt16BE(i + 5); const width = buf.readUInt16BE(i + 7); const components = buf[i + 9];
      if (components !== 1 && components !== 3) throw badRequest('invalid_logo', 'Logo : JPEG RVB ou niveaux de gris attendu.', 'jpeg');
      if (!width || !height || width > 4000 || height > 4000) throw badRequest('invalid_logo', 'Logo : dimensions invalides.', 'jpeg');
      return { width, height, components };
    }
    i += 2 + len;
  }
  throw badRequest('invalid_logo', 'Logo : JPEG illisible.', 'jpeg');
}

/** Dimensions d'un PNG (IHDR) ; refuse tout autre contenu (pas de SVG : risque de script). */
export function inspectPng(buf: Buffer) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig) || buf.toString('latin1', 12, 16) !== 'IHDR') throw badRequest('invalid_logo', 'Logo : PNG attendu pour l’interface.', 'png');
  const width = buf.readUInt32BE(16); const height = buf.readUInt32BE(20);
  if (!width || !height || width > 4000 || height > 4000) throw badRequest('invalid_logo', 'Logo : dimensions invalides.', 'png');
  return { width, height };
}

export const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Identité visuelle appliquée aux documents générés (dans la transaction de l'organisme). */
export async function loadDocBranding(tx: Tx): Promise<DocBranding> {
  const b = await one(tx, `SELECT logo_jpeg, doc_color FROM tenant_branding`);
  if (!b) return {};
  const out: DocBranding = {};
  if (b.logo_jpeg) { const i = inspectJpeg(b.logo_jpeg); out.logo = { data: b.logo_jpeg, ...i }; }
  if (b.doc_color) out.color = hexToRgb(b.doc_color);
  return out;
}
