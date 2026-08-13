import express from "express";
import cors from "cors";
import path from "node:path";
import { configRouter } from "./routes/config";
import { facilityRouter } from "./routes/facility";
import { bookingRouter } from "./routes/booking";
import { taxeSejourRecordRouter } from "./routes/taxeSejourRecord";
import { roomserviceRouter } from "./routes/roomservice";
import { clientPrefsRouter } from "./routes/clientPrefs";
import { loyaltyRouter } from "./routes/loyalty";
import { livretRouter } from "./routes/livret";
import { housekeepingTaskRouter } from "./routes/housekeepingTask";
import { authRouter } from "./routes/auth";
import { errorHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Surface API — endpoints nommés /wa/<entité>/<action> pour rester
  // fidèle à la convention chiefOrchester décrite dans la documentation
  // technique (§6.6), afin de faciliter un futur remplacement par le vrai
  // backend Java com.alphacent.fmk sans changer le contrat front-end.
  app.use("/wa", configRouter);
  app.use("/wa", facilityRouter);
  app.use("/wa", bookingRouter);
  app.use("/wa", taxeSejourRecordRouter);
  app.use("/wa", roomserviceRouter);
  app.use("/wa", clientPrefsRouter);
  app.use("/wa", loyaltyRouter);
  app.use("/wa", livretRouter);
  app.use("/wa", housekeepingTaskRouter);

  // Authentification espace client (hors convention /wa — pas de DAO CRUD dédié)
  app.use("/api", authRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // App client statique (sesame_eco_checkin_boutique.html rebranché sur l'API)
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "checkin.html")));

  app.use(errorHandler);

  return app;
}
