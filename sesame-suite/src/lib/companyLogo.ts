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

function normalizeHex(v: string): string | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h.toLowerCase();
}

/**
 * Couleur de marque (02/11/2026, "reprendre la charte graphique du site
 * client") — lue directement dans le HTML statique du site (balises
 * <meta name="theme-color">/"msapplication-TileColor">), sans dépendance
 * d'analyse d'image (pas de lib de traitement d'image dans ce projet).
 * Ne fonctionne donc que pour les sites qui déclarent ces balises (très
 * répandu, pas universel) — null sinon, jamais une couleur devinée.
 */
export async function fetchBrandColor(site: string): Promise<string | null> {
  const domain = extractDomain(site);
  if (!domain) return null;

  let r: Response;
  try {
    r = await fetch(`https://${domain}`, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SesameBrandBot/1.0)" },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const contentType = r.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return null;

  const html = await r.text();
  const patterns = [
    /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i,
    /<meta[^>]+name=["']msapplication-TileColor["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (m) {
      const hex = normalizeHex(m[1]);
      if (hex) return hex;
    }
  }
  return null;
}
