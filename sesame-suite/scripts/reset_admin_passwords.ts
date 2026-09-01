/**
 * Réinitialise directement en base le mot de passe d'un ou plusieurs
 * comptes admin (ex: super-admin@sesame.technology bloqué, sans accès à un
 * autre compte pour passer par le panneau "Utilisateurs CRM" habituel —
 * cf. POST /wa/adminUser/resetPassword pour l'équivalent normal via l'app).
 *
 * Un mot de passe temporaire lisible est généré (même générateur que
 * l'app, src/lib/password.ts) et affiché UNE SEULE FOIS en clair — rien
 * n'est écrit ailleurs qu'en base (le hash bcrypt) et dans cette sortie
 * console. Ne modifie aucune autre donnée du compte (email, rôle...).
 *
 * Usage (depuis /app dans le conteneur, ou sesame-suite/ en local) :
 *   RESET_EMAILS="super-admin@sesame.technology,autre@ex.com" \
 *   npx tsx scripts/reset_admin_passwords.ts
 *
 * RESET_EMAILS est obligatoire (liste explicite, jamais de défaut implicite
 * comme "tous les comptes sesame") pour ne réinitialiser que les comptes
 * réellement visés.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomPassword } from "../src/lib/password";

const prisma = new PrismaClient();

async function main() {
  const raw = process.env.RESET_EMAILS || "";
  const emails = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (!emails.length) {
    console.error('Variable requise manquante : RESET_EMAILS (ex: RESET_EMAILS="super-admin@sesame.technology")');
    process.exit(1);
  }

  const results: { email: string; password?: string; error?: string }[] = [];
  for (const email of emails) {
    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user) {
      results.push({ email, error: "compte introuvable" });
      continue;
    }
    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash } });
    results.push({ email, password });
  }

  console.log("\n=== Résultat ===");
  for (const r of results) {
    if (r.error) console.log(`✗ ${r.email} — ${r.error}`);
    else console.log(`✓ ${r.email} — nouveau mot de passe : ${r.password}`);
  }
  console.log("\nNotez ces mots de passe maintenant — ils ne sont affichés qu'une fois et ne sont stockés nulle part en clair.");
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
