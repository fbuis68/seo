import { ZipFile } from 'yazl';

/** Modèle de reprise Excel (onglets « Clients » et « Apprenants »), en-têtes reconnus automatiquement. */
export const TEMPLATE_SHEETS: { name: string; headers: string[]; examples: string[][] }[] = [
  {
    name: 'Clients',
    headers: ['Code client', 'Raison sociale', 'Type', 'SIRET', 'N° TVA', 'Email facturation', 'Téléphone', 'Adresse', 'Code postal', 'Ville', 'Financeur', 'Client facturé'],
    examples: [
      ['C001', 'ACME Industrie', 'Entreprise', '73282932000074', 'FR40732829320', 'compta@acme.fr', '0102030405', '12 rue des Lilas', '69003', 'Lyon', 'non', 'oui'],
      ['C002', 'OPCO Exemple', 'Entreprise', '', '', 'factures@opco.fr', '', '1 place du Marché', '75010', 'Paris', 'oui', 'oui'],
      ['C003', 'Martin Sophie', 'Particulier', '', '', 'sophie.martin@mail.fr', '0611223344', '5 allée Verte', '33000', 'Bordeaux', 'non', 'oui'],
    ],
  },
  {
    name: 'Apprenants',
    headers: ['Identifiant', 'Civilité', 'Prénom', 'Nom', 'Email', 'Téléphone', 'Portable', 'Date de naissance', 'Fonction', 'Adresse', 'Code postal', 'Ville', 'Code client', 'Rôle'],
    examples: [
      ['A001', 'M.', 'Jean', 'Dupont', 'jean.dupont@acme.fr', '', '0612345678', '14/02/1988', 'Cariste', '', '', '', 'C001', 'Apprenant'],
      ['A002', 'Mme', 'Lina', 'Bernard', 'lina.bernard@acme.fr', '', '', '03/09/1992', 'Responsable RH', '', '', '', 'C001', 'Contact'],
      ['A003', 'Mme', 'Sophie', 'Martin', 'sophie.martin@mail.fr', '', '0611223344', '', '', '5 allée Verte', '33000', 'Bordeaux', 'C003', 'Apprenant'],
    ],
  },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i: number) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function sheetXml(rows: string[][]) {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join('')}</row>`).join('');
  const widths = rows[0].map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(12, Math.min(40, Math.max(...rows.map((r) => (r[i] ?? '').length)) + 2))}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`;
}

export function templateXlsx(withExamples = true): Promise<Buffer> {
  const zip = new ZipFile();
  const sheets = TEMPLATE_SHEETS;
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`), '[Content_Types].xml');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`), '_rels/.rels');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`), 'xl/workbook.xml');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`), 'xl/_rels/workbook.xml.rels');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`), 'xl/styles.xml');
  sheets.forEach((s, i) => zip.addBuffer(Buffer.from(sheetXml([s.headers, ...(withExamples ? s.examples : [])])), `xl/worksheets/sheet${i + 1}.xml`));
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}
