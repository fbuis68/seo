import { prisma } from "../db";

// Points de vente partenaires de la boutique — cf. schema.prisma Vendor /
// VendorCommission, routes/vendor.ts, public/vendor-portal.html. Ce module
// ne contient que le calcul de commission déclenché à la vente ; le CRUD
// (création de point de vente, portail partenaire, relevé/règlement) vit
// dans routes/vendor.ts.

type CartItem = { id: string; label: string; price: number; qty: number };

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
