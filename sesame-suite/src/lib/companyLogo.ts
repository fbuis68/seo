/**
 * Récupération automatique du logo d'un client (02/11/2026, demande
 * client) — API publique Clearbit Logo, gratuite, sans clé, par domaine.
 * Jamais bloquant ni inventé : si le site n'est pas renseigné ou qu'aucun
 * logo n'est trouvé, l'appelant reçoit null plutôt qu'une image de repli
 * générique (même principe que l'autocomplétion d'adresse/entreprise,
 * cf. entrepriseApi.ts).
 */

function extractDomain(site: string): string | null {
  let s = site.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    return new URL(s).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

export async function fetchCompanyLogo(site: string): Promise<string | null> {
  const domain = extractDomain(site);
  if (!domain) return null;

  let r: Response;
  try {
    r = await fetch(`https://logo.clearbit.com/${encodeURIComponent(domain)}?size=160`);
  } catch {
    return null;
  }
  if (!r.ok) return null;

  const contentType = r.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) return null;

  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) return null; // garde-fou contre une image de repli quasi vide
  return `data:${contentType};base64,${buf.toString("base64")}`;
}
