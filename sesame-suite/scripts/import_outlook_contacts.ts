/**
 * Importe dans le CRM Sesame les contacts extraits d'Outlook (21/09/2026) —
 * liste domaine;Nom;email;statut;téléphone(s);dernier échange, une ligne par
 * personne, regroupées par domaine.
 *
 * Écrit directement en base via Prisma (PAS via POST /wa/crmProspect/create)
 * — choix délibéré : cette route déclenche fireTrigger("crm.prospect_created"),
 * qui peut envoyer un email automatique si une règle d'automatisation existe
 * sur ce déclencheur. Un import de ~100 contacts scrapés d'une boîte mail ne
 * doit PAS spammer silencieusement ces personnes — l'écriture directe évite
 * tout effet de bord.
 *
 * Un CrmProspect par domaine (type="Suspect" — pas d'adresse postale connue,
 * jamais exigée pour ce type), 1er contact du domaine = référent principal
 * de la fiche (nom/email/tel), les suivants deviennent des CrmContact
 * rattachés. Idempotent : un domaine déjà présent (nom identique,
 * insensible à la casse) n'est pas recréé ; un contact déjà présent sous
 * cette fiche (même email) n'est pas redupliqué.
 *
 * Usage (depuis /app dans le conteneur, ou sesame-suite/ en local) :
 *   npx tsx scripts/import_outlook_contacts.ts           # écrit en base
 *   DRY_RUN=1 npx tsx scripts/import_outlook_contacts.ts # aperçu seulement, rien écrit
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === "1";

const RAW_DATA_PATH = path.join(__dirname, "outlook_contacts_raw.txt");

interface Row {
  domain: string;
  name: string;
  email: string;
  phone: string;
}

/**
 * Le texte source (collé depuis le chat) n'a plus de retours à la ligne —
 * chaque ligne s'enchaîne directement après la date de la précédente. On
 * repère les frontières de ligne par la séquence fixe
 * "domaine;nom;email;statut;téléphone;AAAA-MM-JJ" plutôt que de dépendre
 * d'un séparateur qui n'existe plus dans le texte collé.
 */
const ROW_RE =
  /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+);([^;]*);([^;]*);([^;]*);("[^"]*"|[^;]*);(\d{4}-\d{2}-\d{2})/gi;

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const m of text.matchAll(ROW_RE)) {
    const [, domain, name, email, , phoneRaw] = m;
    const phone = phoneRaw.replace(/^"|"$/g, "").trim();
    rows.push({ domain: domain.toLowerCase().trim(), name: name.trim(), email: email.trim().toLowerCase(), phone });
  }
  return rows;
}

/** Nom lisible de repli quand la colonne Nom est vide — dérivé de la partie
 * locale de l'email (ex: "direction@x.fr" -> "Direction") plutôt que de
 * laisser un nom vide (CrmContact.name est obligatoire). */
function fallbackName(email: string): string {
  const local = email.split("@")[0] || email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

function normNom(s: string): string {
  return s.trim().toLowerCase();
}

async function main() {
  const text = fs.readFileSync(RAW_DATA_PATH, "utf8");
  const rows = parseRows(text);
  console.log(`Lignes détectées : ${rows.length}`);
  if (!rows.length) {
    console.error("Aucune ligne détectée — vérifiez le contenu de " + RAW_DATA_PATH);
    process.exit(1);
  }

  const byDomain = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain)!.push(r);
  }
  console.log(`Domaines regroupés : ${byDomain.size}`);

  if (DRY_RUN) {
    console.log("\n=== APERÇU (DRY_RUN=1, rien n'est écrit) ===");
    for (const [domain, group] of byDomain) {
      console.log(`\n${domain} (${group.length} contact${group.length > 1 ? "s" : ""})`);
      group.forEach((r, i) => {
        const label = i === 0 ? "  [fiche principale]" : "  [contact]";
        console.log(`${label} ${r.name || fallbackName(r.email)} <${r.email}> ${r.phone}`);
      });
    }
    return;
  }

  let prospectsCreated = 0;
  let prospectsSkipped = 0;
  let contactsCreated = 0;
  let contactsSkipped = 0;

  for (const [domain, group] of byDomain) {
    const [primary, ...rest] = group;

    let prospect = await prisma.crmProspect.findFirst({
      where: { entityId: null, nom: { equals: domain, mode: "insensitive" } },
    });
    if (prospect) {
      prospectsSkipped++;
      console.log(`DÉJÀ PRÉSENT (fiche sautée) : ${domain}`);
    } else {
      prospect = await prisma.crmProspect.create({
        data: {
          entityId: null,
          nom: domain,
          type: "Suspect",
          origine: "Import Outlook (21/09/2026)",
          referent: primary.name || fallbackName(primary.email),
          email: primary.email || null,
          tel: primary.phone || null,
        },
      });
      prospectsCreated++;
      console.log(`Fiche créée : ${domain} -> ${prospect.id}`);
    }

    for (const r of rest) {
      if (!r.email) continue;
      const existingContact = await prisma.crmContact.findFirst({
        where: { prospectId: prospect.id, email: { equals: r.email, mode: "insensitive" } },
      });
      if (existingContact) {
        contactsSkipped++;
        continue;
      }
      await prisma.crmContact.create({
        data: {
          prospectId: prospect.id,
          name: r.name || fallbackName(r.email),
          email: r.email,
          phone: r.phone || null,
        },
      });
      contactsCreated++;
    }
  }

  console.log("\n=== BILAN ===");
  console.log("Fiches créées :", prospectsCreated);
  console.log("Fiches déjà présentes (sautées) :", prospectsSkipped);
  console.log("Contacts créés :", contactsCreated);
  console.log("Contacts déjà présents (sautés) :", contactsSkipped);
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
