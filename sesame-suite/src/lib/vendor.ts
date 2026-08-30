import { prisma } from "../db";
import { HttpError } from "./asyncHandler";

// Points de vente de la boutique — cf. schema.prisma Vendor / ProductVendor /
// VendorCommission, routes/vendor.ts, public/vendor-portal.html. Ce module
// contient le calcul de commission déclenché à la vente et les helpers de
// rattachement produit <-> point(s) de vente ; le CRUD (création de point de
// vente, portail partenaire, relevé/règlement) vit dans routes/vendor.ts.

type CartItem = { id: string; label: string; price: number; qty: number };

/**
 * Le point de vente interne créé automatiquement pour tout établissement qui
 * n'en a pas encore — garantit qu'un produit du catalogue propre de l'hôtel
 * créé sans sélection explicite de point de vente reste tout de même
 * rattaché à un point de vente (règle : tout produit doit être vendu depuis
 * au moins un point de vente). Les établissements existants avant cette
 * fonctionnalité ont déjà ce point de vente via la migration
 * vendor_points_of_sale ; ce helper couvre les nouveaux établissements créés
 * depuis (onboarding, provisionEntity).
 */
export async function getOrCreateDefaultVendor(entityId: string) {
  const existing = await prisma.vendor.findFirst({ where: { entityId, kind: "internal" }, orderBy: { createdAt: "asc" } });
  if (existing) return existing;
  return prisma.vendor.create({
    data: { entityId, name: "Boutique principale", kind: "internal", status: "active", commissionPct: 0 },
  });
}

/**
 * Valide une liste de points de vente choisis par l'admin pour un produit du
 * catalogue hôtel (jamais depuis le portail partenaire, qui fixe toujours
 * son propre Vendor) — n'accepte que des points de vente "internal" de cet
 * établissement ; un id invalide, d'un autre établissement, ou d'un
 * partenaire fait échouer toute la requête plutôt que d'ignorer
 * silencieusement une erreur de saisie. Liste vide/absente -> point de vente
 * interne par défaut, pour que la règle "toujours au moins un point de
 * vente" ne repose jamais sur la vigilance de l'admin.
 */
export async function resolveInternalVendorIds(entityId: string, vendorIds: string[] | undefined): Promise<string[]> {
  if (!vendorIds || !vendorIds.length) {
    const def = await getOrCreateDefaultVendor(entityId);
    return [def.id];
  }
  const found = await prisma.vendor.findMany({ where: { id: { in: vendorIds }, entityId, kind: "internal" }, select: { id: true } });
  if (found.length !== vendorIds.length) throw new HttpError(400, "Point de vente invalide");
  return found.map((v) => v.id);
}

/**
 * Génère les lignes VendorCommission pour une commande qui vient d'être
 * finalisée (cf. finalizeOrder dans roomservice.ts) — une ligne par point de
 * vente partenaire présent dans le panier, avec le taux de commission en
 * vigueur au moment de la vente (copié depuis Vendor.commissionPct, jamais
 * recalculé rétroactivement si l'hôtel change le taux plus tard). N'écrit
 * rien si aucun article du panier n'appartient à un Vendor (catalogue propre
 * de l'hôtel, cas normal).
 */
export async function recordVendorCommissions(entity: { id: string }, order: { id: string }, items: CartItem[]): Promise<void> {
  if (!items.length) return;
  const products = await prisma.product.findMany({
    where: { id: { in: items.map((it) => it.id) }, entityId: entity.id, vendorId: { not: null } },
    select: { id: true, vendorId: true },
  });
  if (!products.length) return;

  const vendorIdByProduct = new Map(products.map((p) => [p.id, p.vendorId as string]));
  const salesByVendor = new Map<string, number>();
  for (const it of items) {
    const vendorId = vendorIdByProduct.get(it.id);
    if (!vendorId) continue;
    salesByVendor.set(vendorId, (salesByVendor.get(vendorId) || 0) + it.price * it.qty);
  }
  if (!salesByVendor.size) return;

  const vendors = await prisma.vendor.findMany({ where: { id: { in: [...salesByVendor.keys()] } } });
  for (const vendor of vendors) {
    const salesAmount = salesByVendor.get(vendor.id) || 0;
    if (salesAmount <= 0) continue;
    const commissionAmount = Math.round(salesAmount * (vendor.commissionPct / 100) * 100) / 100;
    await prisma.vendorCommission.create({
      data: {
        entityId: entity.id,
        vendorId: vendor.id,
        orderId: order.id,
        salesAmount: Math.round(salesAmount * 100) / 100,
        commissionPct: vendor.commissionPct,
        commissionAmount,
      },
    });
  }
}
