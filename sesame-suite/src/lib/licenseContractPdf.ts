import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";

/**
 * Contrat de licence Sesame (20/11/2026, demande client "prevoir dans le
 * meme espace la signature simultanee sur option du contrat de licence
 * selon le modele") — page de garde générée ici à partir des champs réels
 * du client/devis (même principe que l'en-tête du modèle Word fourni,
 * "licence_modele.docx"), suivie des conditions générales du modèle
 * (page statique extraite une fois pour toutes, cf. public/legal/
 * contrat-licence-cgv.pdf — même méthode que generateQuotePdf pour la CGV
 * du devis). Le mandat de prélèvement SEPA papier du modèle (page 3) n'est
 * PAS repris ici : remplacé par le mandat GoCardless électronique déjà géré
 * par crmSignature.ts (requiresBankMandate + createSepaMandate), qui ajoute
 * sa propre page récapitulative à la signature (cf. lib/signaturePdf.ts).
 */
export interface LicenseContractData {
  contractNumber: string;
  companyName: string;
  siret?: string;
  contactName?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  phone?: string;
  email?: string;
  licenceMensuelleHT: number;
  totalMensuelTTC: number;
  commercialName?: string;
}

const MARGIN_X = 50;
const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;

export async function buildLicenseContractPdf(data: LicenseContractData): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0.13, 0.4, 0.67);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  let y = PAGE_HEIGHT - 60;
  const title = (text: string) => {
    page.drawText(text, { x: MARGIN_X, y, size: 13, font: bold, color: blue });
    y -= 10;
    page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 22;
  };
  const row = (label: string, value: string) => {
    page.drawText(label, { x: MARGIN_X, y, size: 10, font: bold });
    page.drawText(value || "—", { x: MARGIN_X + 170, y, size: 10, font });
    y -= 18;
  };

  page.drawText("SESAME TECHNOLOGY", { x: MARGIN_X, y, size: 18, font: bold, color: blue });
  y -= 26;
  page.drawText(`CONTRAT SESAME N°${data.contractNumber}`, { x: MARGIN_X, y, size: 14, font: bold, color: blue });
  y -= 36;

  title("CLIENT");
  row("Raison sociale", data.companyName);
  row("SIRET", data.siret || "—");
  row("Contact", data.contactName || "—");
  row("Adresse", data.address || "—");
  row("Code postal / Ville", [data.postalCode, data.city].filter(Boolean).join(" ") || "—");
  row("Téléphone", data.phone || "—");
  row("Email", data.email || "—");
  y -= 14;

  title("MODE DE REGLEMENT — CONDITIONS TARIFAIRES");
  page.drawText("Abonnement", { x: MARGIN_X, y, size: 10.5, font: bold });
  y -= 18;
  row("Licence mensuelle HT", `${data.licenceMensuelleHT.toFixed(2).replace(".", ",")} €`);
  row("Total mensuel TTC", `${data.totalMensuelTTC.toFixed(2).replace(".", ",")} €`);
  y -= 14;

  page.drawText(
    "L'utilisation du service SESAME TECHNOLOGY FRANCE nécessite un micro-ordinateur équipé d'un navigateur",
    { x: MARGIN_X, y, size: 9, font }
  );
  y -= 12;
  page.drawText("Internet et d'un accès à Internet, non inclus dans la prestation.", { x: MARGIN_X, y, size: 9, font });
  y -= 30;

  title("POUR LE CLIENT");
  page.drawText(
    "Je certifie exactes les informations figurant sur le présent document. Je reconnais avoir reçu ce jour un",
    { x: MARGIN_X, y, size: 9.5, font }
  );
  y -= 13;
  page.drawText(
    "exemplaire des conditions générales du contrat de service ci-après, en avoir pris connaissance et les accepter",
    { x: MARGIN_X, y, size: 9.5, font }
  );
  y -= 13;
  page.drawText("sans aucune restriction. La preuve de signature électronique figure en dernière page du présent document.", {
    x: MARGIN_X,
    y,
    size: 9.5,
    font,
  });
  y -= 24;
  if (data.commercialName) {
    page.drawText(`Pour SESAME TECHNOLOGY FRANCE : ${data.commercialName}`, { x: MARGIN_X, y, size: 9.5, font: bold });
  }

  // Conditions générales — page statique extraite une fois du modèle Word
  // fourni (licence_modele.docx), jamais régénérée à la volée.
  const cgvPath = path.join(__dirname, "..", "..", "public", "legal", "contrat-licence-cgv.pdf");
  try {
    const cgvBytes = fs.readFileSync(cgvPath);
    const cgvDoc = await PDFDocument.load(cgvBytes);
    const copied = await doc.copyPages(cgvDoc, cgvDoc.getPageIndices());
    copied.forEach((p) => doc.addPage(p));
  } catch (e) {
    console.error("[licenseContractPdf] CGV introuvable, contrat généré sans :", e);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes).toString("base64");
}
