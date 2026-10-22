import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Catalogue produits interne Sesame (18/08/2026) — matériel et prestations
 * facturables au devis (distinct du catalogue "modules" SaaS utilisé pour le
 * pricing des souscriptions, cf. onboarding.ts). Le flag stockable prépare
 * une future gestion de stock (non implémentée ici, cf. schema.prisma).
 */
export const crmProductRouter = Router();

const PRODUCT_CATEGORIES = ["materiel", "logiciel", "service", "autre"] as const;
function isProductCategory(v: unknown): v is (typeof PRODUCT_CATEGORIES)[number] {
  return typeof v === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(v);
}

function shapeProduct(p: {
  id: string;
  sku: string | null;
  label: string;
  description: string | null;
  unitPrice: number;
  recurring: boolean;
  category: string;
  stockable: boolean;
  stockQty: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    sku: p.sku || "",
    label: p.label,
    description: p.description || "",
    unitPrice: p.unitPrice,
    recurring: p.recurring,
    category: p.category,
    stockable: p.stockable,
    stockQty: p.stockQty,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

crmProductRouter.get(
  "/crmProduct/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmProduct.findMany({ orderBy: { label: "asc" } });
    res.json(rows.map(shapeProduct));
  })
);

interface ProductBody {
  sku?: string;
  label: string;
  description?: string;
  unitPrice?: number;
  recurring?: boolean;
  category?: string;
  stockable?: boolean;
  active?: boolean;
}

crmProductRouter.post(
  "/crmProduct/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ProductBody;
    if (!b.label || !b.label.trim()) throw new HttpError(400, "Libellé requis");
    if (b.category !== undefined && !isProductCategory(b.category)) throw new HttpError(400, "Catégorie invalide (materiel, logiciel, service ou autre)");
    const row = await prisma.crmProduct.create({
      data: {
        sku: b.sku?.trim() || null,
        label: b.label.trim(),
        description: b.description,
        unitPrice: b.unitPrice ?? 0,
        recurring: !!b.recurring,
        category: b.category || "materiel",
        stockable: !!b.stockable,
      },
    });
    res.status(201).json(shapeProduct(row));
  })
);

crmProductRouter.post(
  "/crmProduct/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as ProductBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    if (b.label !== undefined && !b.label.trim()) throw new HttpError(400, "Le libellé ne peut pas être vide");
    if (b.category !== undefined && !isProductCategory(b.category)) throw new HttpError(400, "Catégorie invalide (materiel, logiciel, service ou autre)");
    const existing = await prisma.crmProduct.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Produit introuvable");
    const row = await prisma.crmProduct.update({
      where: { id },
      data: {
        sku: b.sku !== undefined ? b.sku.trim() || null : undefined,
        label: b.label?.trim(),
        description: b.description,
        unitPrice: b.unitPrice,
        recurring: b.recurring,
        category: b.category,
        stockable: b.stockable,
        active: b.active,
      },
    });
    res.json(shapeProduct(row));
  })
);

crmProductRouter.post(
  "/crmProduct/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmProduct.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Produit introuvable");
    await prisma.crmProduct.delete({ where: { id } });
    res.json({ ok: true });
  })
);
