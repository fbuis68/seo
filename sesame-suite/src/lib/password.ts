/** Générateur de mot de passe temporaire — sans caractères ambigus
 * (0/O, 1/l/I) pour rester lisible/dictable au téléphone. */
export function randomPassword(len = 12): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
