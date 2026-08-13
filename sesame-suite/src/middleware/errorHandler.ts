import { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/asyncHandler";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
}
