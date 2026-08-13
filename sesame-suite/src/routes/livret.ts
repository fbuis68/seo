import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const livretRouter = Router();

function shapeSection(s: { id: string; title: string; icon: string | null; content: string; sortOrder: number; published: boolean }) {
  return {
    id: s.id,
    title: s.title,
    ico: s.icon || "ti-file-text",
    content: s.content,
    sortOrder: s.sortOrder,
    published: s.published,
  };
}

/**
 * GET /wa/livret/list?all=true — rubriques du livret digital.
 * Par défaut ne renvoie que les rubriques publiées (consultation client) ;
 * `all=true` renvoie aussi les brouillons (édition back-office).
 */
livretRouter.get(
  "/livret/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const all = req.query.all === "true";
    const sections = await prisma.livretSection.findMany({
      where: { entityId: entity.id, ...(all ? {} : { published: true }) },
      orderBy: { sortOrder: "asc" },
    });
    res.json(sections.map(shapeSection));
  })
);

interface SectionBody {
  title: string;
  ico?: string;
  content?: string;
  sortOrder?: number;
  published?: boolean;
}

/** POST /wa/livret/create — éditeur de rubriques (back-office). */
livretRouter.post(
  "/livret/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as SectionBody;
    if (!b.title) throw new HttpError(400, "title requis");

    const maxOrder = await prisma.livretSection.count({ where: { entityId: entity.id } });
    const section = await prisma.livretSection.create({
      data: {
        entityId: entity.id,
        title: b.title,
        icon: b.ico || "ti-file-text",
        content: b.content || "",
        sortOrder: b.sortOrder ?? maxOrder,
        published: b.published ?? false,
      },
    });
    res.status(201).json(shapeSection(section));
  })
);

/** POST /wa/livret/update — body: { id, ...champs } (inclut le toggle "published"). */
livretRouter.post(
  "/livret/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { id, ...b } = req.body as SectionBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");

    const section = await prisma.livretSection.findFirst({ where: { id, entityId: entity.id } });
    if (!section) throw new HttpError(404, "Rubrique introuvable");

    const updated = await prisma.livretSection.update({
      where: { id },
      data: { title: b.title, icon: b.ico, content: b.content, sortOrder: b.sortOrder, published: b.published },
    });
    res.json(shapeSection(updated));
  })
);

/** POST /wa/livret/delete — body: { id } */
livretRouter.post(
  "/livret/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const id = (req.body.id as string) || "";
    const section = await prisma.livretSection.findFirst({ where: { id, entityId: entity.id } });
    if (!section) throw new HttpError(404, "Rubrique introuvable");
    await prisma.livretSection.delete({ where: { id } });
    res.json({ ok: true });
  })
);
