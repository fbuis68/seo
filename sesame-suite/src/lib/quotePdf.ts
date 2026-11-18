import fs from "fs";
import path from "path";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, PDFImage } from "pdf-lib";

/**
 * Génération d'un vrai PDF téléchargeable/consultable du devis — 18/11/2026,
 * "prévoir une présentation sur option avec de présentation de ce type"
 * (exemple fourni : un document PDF encadré, avec boutons Ouvrir/
 * Télécharger). Vient s'ajouter à la présentation "classique" existante
 * (quoteSummaryHtml côté public/devis-signature.html), qui reste la
 * présentation par défaut — c'est le CLIENT qui bascule de l'une à
 * l'autre sur sa page, cf. switchQuoteView.
 *
 * pdf-lib est une bibliothèque de dessin bas niveau (pas de rendu HTML→PDF) :
 * tout le texte est positionné à la main, avec retour à la ligne et saut de
 * page gérés ici.
 */

export interface QuotePdfLine {
  label: string;
  description?: string;
  qty: number;
  unitPrice: number | null;
  recurring: boolean;
  category?: string;
}

export interface QuotePdfData {
  number: string;
  title: string;
  prospectNom: string;
  introText: string;
  mentionsText: string;
  termsText: string;
  lines: QuotePdfLine[];
  totals: { oneoffNet: number; mrrNet: number };
  prospectLogo?: string | null; // data URL
  commercialName?: string;
  commercialEmail?: string;
  commercialPhone?: string;
  commercialPhoto?: string | null; // data URL
  alreadySigned?: boolean;
  signerName?: string | null;
  signedAt?: Date | null;
}

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 50;
const MARGIN_TOP = 70;
const MARGIN_BOTTOM = 60;

const CATEGORY_LABEL: Record<string, string> = { materiel: "Matériel", service: "Service", logiciel: "Licence", autre: "Lignes libres" };
const CATEGORY_ORDER = ["materiel", "service", "logiciel", "autre"];

// La police standard Helvetica (encodage WinAnsi) couvre le Latin-1/CP1252
// ET le signe € (byte 0x80 de cp1252) — mais PAS l'espace fine insécable
// (U+202F) que toLocaleString('fr-FR') insère par défaut comme séparateur
// de milliers, ni les guillemets/tirets typographiques qu'un commercial
// peut coller depuis Word : remplacements ciblés plutôt qu'un filtre
// générique qui aurait aussi supprimé le €.
function sanitizeForPdf(s: string): string {
  return String(s ?? "")
    .replace(/[    ]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...");
}

// Filet de sécurité générique (emoji, CJK... tout caractère resté hors de
// WinAnsi après sanitizeForPdf) — n'est tenté qu'APRÈS un premier échec de
// drawText, pour ne jamais abîmer un texte qui passait déjà très bien
// (ex: le € lui-même serait détruit par un filtre Latin-1 naïf).
function asciiFallback(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF€]/g, "?");
}

function fmtEUR(n: number | null | undefined): string {
  return sanitizeForPdf((n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €");
}

/** drawText avec repli ASCII en cas d'échec d'encodage — jamais de crash sur
 * un caractère imprévu dans du texte libre (notes, nom du commercial...). */
function safeDrawText(page: PDFPage, str: string, opts: Parameters<PDFPage["drawText"]>[1]) {
  const clean = sanitizeForPdf(str);
  try {
    page.drawText(clean, opts);
  } catch {
    page.drawText(asciiFallback(clean), opts);
  }
}

function dataUrlToBytes(dataUrl: string): { bytes: Buffer; isPng: boolean } | null {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || "");
  if (!m) return null;
  return { bytes: Buffer.from(m[2], "base64"), isPng: m[1] === "png" };
}

/** Coupe un texte en lignes qui tiennent dans `maxWidth`, au mot près. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitizeForPdf(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** État mutable partagé entre les helpers de dessin (page courante + position Y),
 * avec saut de page automatique dès que le contenu dépasse MARGIN_BOTTOM. */
class PdfCursor {
  doc: PDFDocument;
  font: PDFFont;
  boldFont: PDFFont;
  page: PDFPage;
  y = 0;
  pageNum = 0;

  constructor(doc: PDFDocument, font: PDFFont, boldFont: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.boldFont = boldFont;
    this.page = this.newPage();
  }
  newPage(): PDFPage {
    this.pageNum++;
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN_TOP;
    return page;
  }
  ensureSpace(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.page = this.newPage();
  }
  text(str: string, opts: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {}) {
    safeDrawText(this.page, str, { x: opts.x ?? MARGIN_X, y: this.y, size: opts.size ?? 10, font: opts.font ?? this.font, color: opts.color ?? rgb(0.1, 0.1, 0.1) });
  }
  hr(color = rgb(0.85, 0.85, 0.85)) {
    this.page.drawLine({ start: { x: MARGIN_X, y: this.y }, end: { x: PAGE_WIDTH - MARGIN_X, y: this.y }, thickness: 0.6, color });
  }
}

export async function generateQuotePdf(data: QuotePdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = rgb(0.545, 0.063, 0.251); // #8b1040, même accent que devis-signature.html

  const c = new PdfCursor(doc, font, boldFont);

  // ─── En-tête : logo Sesame + logo client éventuel ───────────────────────
  async function embedDataUrlImage(dataUrl: string | null | undefined): Promise<PDFImage | null> {
    if (!dataUrl) return null;
    const parsed = dataUrlToBytes(dataUrl);
    if (!parsed) return null;
    try {
      return parsed.isPng ? await doc.embedPng(parsed.bytes) : await doc.embedJpg(parsed.bytes);
    } catch {
      return null;
    }
  }

  let sesameLogo: PDFImage | null = null;
  try {
    const logoPath = path.join(__dirname, "..", "..", "public", "icons", "sesame-logo.jpg");
    sesameLogo = await doc.embedJpg(fs.readFileSync(logoPath));
  } catch {
    sesameLogo = null;
  }
  if (sesameLogo) {
    const h = 28;
    const w = (sesameLogo.width / sesameLogo.height) * h;
    c.page.drawImage(sesameLogo, { x: MARGIN_X, y: PAGE_HEIGHT - 50, width: w, height: h });
  }
  const clientLogo = await embedDataUrlImage(data.prospectLogo);
  if (clientLogo) {
    const h = 28;
    const w = (clientLogo.width / clientLogo.height) * h;
    c.page.drawImage(clientLogo, { x: PAGE_WIDTH - MARGIN_X - w, y: PAGE_HEIGHT - 50, width: w, height: h });
  }

  // ─── Bloc contact commercial (18/11/2026, "coordonnées du commercial en
  // entête avec téléphone et email et photo" côté page HTML — "ne pas
  // mettre la photo sur le pdf" : photo exclue ici, seulement nom/tél/email). ─
  if (data.commercialName) {
    const boxW = 230;
    const textX = PAGE_WIDTH - MARGIN_X - boxW;
    let by = c.y;
    safeDrawText(c.page, "Votre contact", { x: textX, y: by - 10, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
    safeDrawText(c.page, data.commercialName || "", { x: textX, y: by - 22, size: 10.5, font: boldFont });
    let detailY = by - 34;
    if (data.commercialPhone) {
      safeDrawText(c.page, data.commercialPhone || "", { x: textX, y: detailY, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
      detailY -= 11;
    }
    if (data.commercialEmail) {
      safeDrawText(c.page, data.commercialEmail || "", { x: textX, y: detailY, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
    }
  }

  c.y = PAGE_HEIGHT - MARGIN_TOP - 40;
  c.text(`Devis ${data.number}`, { size: 18, font: boldFont, color: accent });
  c.y -= 20;
  c.text(data.prospectNom + (data.title ? " — " + data.title : ""), { size: 11, color: rgb(0.4, 0.4, 0.4) });
  c.y -= 22;

  if (data.introText) {
    for (const line of wrapText(data.introText, font, 10, PAGE_WIDTH - 2 * MARGIN_X)) {
      c.ensureSpace(14);
      c.text(line, { size: 10 });
      c.y -= 14;
    }
    c.y -= 8;
  }

  // ─── Tableaux par catégorie (mêmes 4 rubriques que quoteBlocksHtml) ─────
  const colLabelW = 300;
  const colQtyX = MARGIN_X + colLabelW + 10;
  const colPriceX = colQtyX + 50;
  const colTotalX = PAGE_WIDTH - MARGIN_X - 70;

  function tableHeader() {
    c.ensureSpace(24);
    c.text("Prestation", { size: 8.5, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
    c.text("Qté", { x: colQtyX, size: 8.5, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
    c.text("PU HT", { x: colPriceX, size: 8.5, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
    c.text("Total HT", { x: colTotalX, size: 8.5, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
    c.y -= 6;
    c.hr();
    c.y -= 14;
  }

  for (const cat of CATEGORY_ORDER) {
    const rows = data.lines.filter((l) => (l.category || "materiel") === cat);
    if (!rows.length) continue;
    c.ensureSpace(40);
    c.text(CATEGORY_LABEL[cat] || cat, { size: 11, font: boldFont, color: accent });
    c.y -= 16;
    tableHeader();
    let subtotal = 0;
    for (const l of rows) {
      const labelLines = wrapText(l.label, boldFont, 9.5, colLabelW);
      const descLines = l.description ? wrapText(l.description, font, 8, colLabelW) : [];
      const rowHeight = 13 * labelLines.length + 10 * descLines.length + 6;
      c.ensureSpace(rowHeight);
      const total = l.unitPrice == null ? null : (l.qty || 0) * l.unitPrice;
      if (total != null) subtotal += total;
      labelLines.forEach((ln, i) => safeDrawText(c.page, ln, { x: MARGIN_X, y: c.y - i * 13, size: 9.5, font: boldFont }));
      safeDrawText(c.page, String(l.qty), { x: colQtyX, y: c.y, size: 9.5, font });
      safeDrawText(c.page, l.unitPrice == null ? "À chiffrer" : fmtEUR(l.unitPrice), { x: colPriceX, y: c.y, size: 9.5, font });
      safeDrawText(c.page, total == null ? "—" : fmtEUR(total) + (l.recurring ? "/mois" : ""), { x: colTotalX, y: c.y, size: 9.5, font });
      c.y -= 13 * labelLines.length;
      descLines.forEach((ln, i) => safeDrawText(c.page, ln, { x: MARGIN_X, y: c.y - i * 10, size: 8, font, color: rgb(0.5, 0.5, 0.5) }));
      c.y -= 10 * descLines.length + 6;
    }
    c.ensureSpace(16);
    c.text(`Sous-total ${CATEGORY_LABEL[cat] || cat}`, { size: 9.5, font: boldFont });
    c.text(fmtEUR(subtotal), { x: colTotalX, size: 9.5, font: boldFont });
    c.y -= 22;
  }

  // ─── Totaux ──────────────────────────────────────────────────────────
  c.ensureSpace(60);
  c.hr(rgb(0.7, 0.7, 0.7));
  c.y -= 20;
  c.text("Montant HT", { size: 10, font: boldFont });
  c.text(fmtEUR(data.totals.oneoffNet), { x: colTotalX, size: 13, font: boldFont, color: accent });
  c.y -= 18;
  if (data.totals.mrrNet > 0) {
    c.text("Licence (mensuel)", { size: 10, font: boldFont });
    c.text(fmtEUR(data.totals.mrrNet), { x: colTotalX, size: 13, font: boldFont, color: accent });
    c.y -= 18;
  }
  c.y -= 10;

  // ─── Notes libres ────────────────────────────────────────────────────
  function notesBlock(title: string, body: string | null | undefined) {
    if (!body) return;
    c.ensureSpace(24);
    c.text(title.toUpperCase(), { size: 8.5, font: boldFont, color: accent });
    c.y -= 14;
    for (const line of wrapText(body, font, 9, PAGE_WIDTH - 2 * MARGIN_X)) {
      c.ensureSpace(13);
      c.text(line, { size: 9, color: rgb(0.3, 0.3, 0.3) });
      c.y -= 13;
    }
    c.y -= 10;
  }
  notesBlock("Mentions spécifiques", data.mentionsText);
  notesBlock("Conditions commerciales", data.termsText);

  if (data.alreadySigned) {
    c.ensureSpace(20);
    const d = data.signedAt ? data.signedAt.toLocaleDateString("fr-FR") : "";
    c.text(`Devis signe par ${data.signerName || ""}${d ? " le " + d : ""}`, { size: 9.5, font: boldFont, color: rgb(0.1, 0.42, 0.28) });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
