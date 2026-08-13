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
import { housekeepingStaffRouter } from "./routes/housekeepingStaff";
import { crmRouter } from "./routes/crm";
import { campaignRouter } from "./routes/campaign";
import { authRouter } from "./routes/auth";
import { loginRouter } from "./routes/login";
import { entityRouter } from "./routes/entity";
import { subscriptionRouter } from "./routes/subscription";
import { groupRouter } from "./routes/group";
import { errorHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(cors());
  // Limite relevée : logos, photos de chambres et plan d'hôtel transitent en
  // base64 dans le JSON (comme dans le prototype d'origine).
  app.use(express.json({ limit: "15mb" }));

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
  app.use("/wa", housekeepingStaffRouter);
  app.use("/wa", crmRouter);
  app.use("/wa", campaignRouter);
  app.use("/wa", loginRouter);
  app.use("/wa", entityRouter);
  app.use("/wa", subscriptionRouter);
  app.use("/wa", groupRouter);

  // Authentification espace client (hors convention /wa — pas de DAO CRUD dédié)
  app.use("/api", authRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Apps statiques (HTML/CSS/JS d'origine, rebranchées sur l'API)
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "checkin.html")));
  app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

  app.use(errorHandler);

  return app;
}
