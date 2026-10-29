/**
 * Corrige l'import CSV "suspects" déjà fait AVANT le fix du 29/10/2026
 * (impLookupAddresses sautait l'appel API dès que l'adresse était déjà
 * connue du fichier — le dirigeant n'était donc jamais récupéré pour ces
 * lignes-là, ex. import CAMPINGS.csv). Rattrape a posteriori : cherche le
 * dirigeant via recherche-entreprises.api.gouv.fr pour toute CrmProspect
 * sans referent, et le remplit si trouvé — même logique de rapprochement
 * que côté client (ville si connue, sinon premier résultat).
 *
 * N'écrase JAMAIS un referent déjà renseigné. Lancer une seule fois après
 * déploiement du fix :
 *   tsx scripts/backfill-prospect-dirigeant.ts
 *   tsx scripts/backfill-prospect-dirigeant.ts --secteur "Hébergement plein air"   (limiter à un secteur)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

interface Dirigeant {
  type_dirigeant?: string;
  nom?: string;
  prenoms?: string;
}
interface EntrepriseResult {
  siege?: { libelle_commune?: string };
  dirigeants?: Dirigeant[];
}

async function findDirigeant(nom: string, ville: string | null): Promise<string | null> {
  try {
    const r = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(nom)}&limit=3`);
    if (!r.ok) return null;
    const data = (await r.json()) as { results?: EntrepriseResult[] };
    const results = data.results || [];
    const villeNorm = ville ? norm(ville) : "";
    const match = results.find((e) => !villeNorm || norm(e.siege?.libelle_commune || "") === villeNorm);
    if (!match) return null;
    const dirigeants = match.dirigeants || [];
    const dirigeant = dirigeants.find((d) => d.type_dirigeant === "personne physique") || dirigeants[0];
    if (!dirigeant || dirigeant.type_dirigeant === "personne morale") return null;
    const name = [dirigeant.prenoms, dirigeant.nom].filter(Boolean).join(" ").trim();
    return name || null;
  } catch {
    return null;
  }
}

async function main() {
  const secteurArgIdx = process.argv.indexOf("--secteur");
  const secteur = secteurArgIdx >= 0 ? process.argv[secteurArgIdx + 1] : undefined;

  const rows = await prisma.crmProspect.findMany({
    where: {
      OR: [{ referent: null }, { referent: "" }],
      nom: { not: "" },
      ...(secteur ? { secteur } : {}),
    },
    select: { id: true, nom: true, ville: true },
  });
  console.log(`${rows.length} fiche(s) sans contact à traiter${secteur ? ` (secteur: ${secteur})` : ""}.`);

  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const referent = await findDirigeant(row.nom, row.ville);
    if (referent) {
      await prisma.crmProspect.update({ where: { id: row.id }, data: { referent } });
      updated++;
      console.log(`[${i + 1}/${rows.length}] ${row.nom} → ${referent}`);
    } else {
      console.log(`[${i + 1}/${rows.length}] ${row.nom} → non trouvé`);
    }
    await new Promise((res) => setTimeout(res, 250)); // API publique gratuite, pas de clé — pas de raison de la marteler
  }
  console.log(`${updated}/${rows.length} fiche(s) complétée(s) avec un dirigeant.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
