import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler } from "../lib/asyncHandler";

export const livretRouter = Router();

/** GET /wa/livret/list?entityCode= — rubriques publiées du livret digital. */
livretRouter.get(
  "/livret/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const sections = await prisma.livretSection.findMany({
      where: { entityId: entity.id, published: true },
      orderBy: { sortOrder: "asc" },
    });
    res.json(
      sections.map((s) => ({
        id: s.id,
        title: s.title,
        ico: s.icon || "ti-file-text",
        content: s.content,
        published: s.published,
      }))
    );
  })
);
