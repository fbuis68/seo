/**
 * Politique de mot de passe (24/09/2026) — imposée à TOUS les comptes
 * (AdminUser, quel que soit le rôle) : au moins 10 caractères, au moins un
 * chiffre, au moins un caractère spécial. Un seul point de vérité
 * (validatePasswordPolicy) réutilisé partout où un mot de passe est fourni
 * par un humain — création manuelle (crmUser/adminUser/entity/create),
 * réinitialisation (login/resetPassword) — pour ne jamais laisser un
 * chemin d'écriture divergent de la règle.
 */
const SPECIAL_CHARS = "!@#$%&*-_+=";
const SPECIAL_RE = /[!@#$%&*\-_+=.,;:?/()[\]{}~^|\\'"<>`]/;

export function validatePasswordPolicy(password: string): string | null {
  if (!password || password.length < 10) return "Le mot de passe doit contenir au moins 10 caractères";
  if (!/\d/.test(password)) return "Le mot de passe doit contenir au moins un chiffre";
  if (!SPECIAL_RE.test(password)) return "Le mot de passe doit contenir au moins un caractère spécial";
  return null;
}

/**
 * Générateur de mot de passe temporaire — sans caractères ambigus
 * (0/O, 1/l/I) pour rester lisible/dictable au téléphone. Conforme par
 * construction à validatePasswordPolicy (un chiffre et un caractère spécial
 * placés explicitement, pas seulement probables) — un mot de passe généré
 * automatiquement doit toujours passer sa propre règle.
 */
export function randomPassword(len = 12): string {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = letters + digits + SPECIAL_CHARS;
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];

  const size = Math.max(len, 10);
  const out = [pick(digits), pick(SPECIAL_CHARS)];
  for (let i = out.length; i < size; i++) out.push(pick(all));

  // Mélange (Fisher-Yates) — sinon le chiffre et le caractère spécial
  // seraient toujours en tête, un motif reconnaissable.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}
