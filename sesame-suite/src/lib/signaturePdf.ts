import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Ajoute une page récapitulative (identité entreprise + mandat SEPA +
 * preuve de signature) au PDF du contrat uploadé par l'admin — 27/10/2026,
 * demande client. Ne modifie jamais les pages existantes, se contente
 * d'ajouter une page à la fin : le document d'origine (CGV etc.) reste
 * intact et consultable tel quel.
 *
 * C'est cette page qui porte l'IBAN/BIC en clair — conforme à la décision
 * prise avec le client : aucune colonne base de données séparée, seulement
 * le PDF final (même principe qu'un mandat papier scanné et archivé).
 */
export interface MandateSummaryData {
  companyName: string;
  siret?: string;
  contactName: string;
  address?: string;
  postalCode?: string;
  city?: string;
  phone?: string;
  email: string;
  accountHolderName: string;
  bankName?: string;
  bic?: string;
  iban: string;
  mandateReference: string;
  signedAt: Date;
  signerIp: string;
  creditorIcs: string;
}

const MARGIN_X = 50;
const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;

export async function appendMandateSummaryPage(baseFileBase64: string, data: MandateSummaryData): Promise<string> {
  const doc = await PDFDocument.load(Buffer.from(baseFileBase64, "base64"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  let y = PAGE_HEIGHT - 60;
  const title = (text: string) => {
    page.drawText(text, { x: MARGIN_X, y, size: 13, font: boldFont, color: rgb(0.13, 0.4, 0.67) });
    y -= 10;
    page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 22;
  };
  const row = (label: string, value: string) => {
    page.drawText(label, { x: MARGIN_X, y, size: 10, font: boldFont });
    page.drawText(value || "—", { x: MARGIN_X + 170, y, size: 10, font });
    y -= 18;
  };

  page.drawText("Informations renseignées par le signataire", { x: MARGIN_X, y, size: 16, font: boldFont });
  y -= 36;

  title("Identité de l'entreprise");
  row("Raison sociale", data.companyName);
  row("SIRET", data.siret || "—");
  row("Contact", data.contactName);
  row("Adresse", [data.address, data.postalCode, data.city].filter(Boolean).join(" "));
  row("Téléphone", data.phone || "—");
  row("Email", data.email);
  y -= 14;

  title("Mandat de prélèvement SEPA");
  row("Référence unique de mandat (RUM)", data.mandateReference);
  row("Créancier", `SESAME TECHNOLOGY FRANCE — ICS ${data.creditorIcs}`);
  row("Titulaire du compte", data.accountHolderName);
  row("Banque", data.bankName || "—");
  row("BIC", data.bic || "—");
  row("IBAN", formatIban(data.iban));
  y -= 14;

  title("Preuve de signature électronique");
  row("Signé le", data.signedAt.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }));
  row("Adresse IP", data.signerIp);

  const bytes = await doc.save();
  return Buffer.from(bytes).toString("base64");
}

function formatIban(iban: string): string {
  const clean = iban.replace(/\s/g, "").toUpperCase();
  return clean.match(/.{1,4}/g)?.join(" ") || clean;
}
