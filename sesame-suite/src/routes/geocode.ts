import { Router } from "express";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Géocodage adresse -> lat/lng pour la vue Carte du CRM (public/crm.html,
 * renderMapView) et l'autocomplétion d'adresse du formulaire fiche client.
 *
 * Deux fournisseurs, choisis selon le pays déclaré sur la fiche :
 * - api-adresse.data.gouv.fr (Base Adresse Nationale) pour la France —
 *   gratuit, sans clé, précis, mais ne connaît QUE les adresses françaises :
 *   une fiche à l'étranger n'y trouve jamais de résultat, quel que soit le
 *   contenu du champ adresse (c'est ce qui faisait que la carte ne
 *   localisait jamais les clients hors France, alors que le champ "Pays" du
 *   formulaire les acceptait très bien en saisie).
 * - Nominatim (OpenStreetMap) en repli pour tout pays non français —
 *   couverture mondiale, gratuit, sans clé, mais sa politique d'usage
 *   impose un User-Agent identifiant l'application et un maximum d'1
 *   requête/seconde (https://operations.osmfoundation.org/policies/nominatim/)
 *   — un throttle global process est appliqué ci-dessous plutôt que de
 *   compter sur le délai côté navigateur (insuffisant, et non partagé entre
 *   plusieurs utilisateurs CRM ouvrant la carte en même temps).
 */
export const geocodeRouter = Router();

const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimCallAt = 0;

async function throttleNominatim() {
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCallAt = Date.now();
}

async function searchBAN(q: string, limit: number): Promise<{ lat: number; lng: number; label: string }[]> {
  const r = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!r.ok) return [];
  const j = (await r.json()) as { features?: { geometry?: { coordinates?: [number, number] }; properties?: { label?: string } }[] };
  return (j.features || [])
    .filter((f) => f.geometry?.coordinates)
    .map((f) => ({ lng: f.geometry!.coordinates![0], lat: f.geometry!.coordinates![1], label: f.properties?.label || q }));
}

async function searchNominatim(q: string, limit: number): Promise<{ lat: number; lng: number; label: string }[]> {
  await throttleNominatim();
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=${limit}`, {
    headers: { "User-Agent": "SesameSuiteCRM/1.0 (contact: support@sesame.technology)" },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { lat: string; lon: string; display_name: string }[];
  return j.map((row) => ({ lat: Number(row.lat), lng: Number(row.lon), label: row.display_name }));
}

const isFrance = (pays: string) => !pays || /france/i.test(pays);

/** GET /wa/geocode?q=<adresse>&pays=<pays>&limit=<n> — un seul résultat par défaut (carte), plusieurs pour l'autocomplétion. */
geocodeRouter.get(
  "/geocode",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) throw new HttpError(400, "q requis");
    const pays = String(req.query.pays || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 1, 1), 10);

    let results = isFrance(pays) ? await searchBAN(q, limit) : [];
    if (!results.length) results = await searchNominatim(q, limit);

    res.json({ results });
  })
);
