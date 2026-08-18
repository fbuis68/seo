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
import { bookingSourceRouter } from "./routes/bookingSource";
import { onboardingRouter } from "./routes/onboarding";
import { crmProspectRouter } from "./routes/crmProspect";
import { crmDealRouter } from "./routes/crmDeal";
import { crmQuoteRouter } from "./routes/crmQuote";
import { crmUserRouter } from "./routes/crmUser";
import { crmProductRouter } from "./routes/crmProduct";
import { contactRouter } from "./routes/contact";
import { emailRouter } from "./routes/email";
import { messagingRouter } from "./routes/messaging";
import { automationRuleRouter } from "./routes/automationRule";
import { adminUserRouter } from "./routes/adminUser";
import { errorHandler } from "./middleware/errorHandler";
import { VERSION } from "./lib/version";
import { CHANGELOG } from "./lib/changelog";

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
  app.use("/wa", bookingSourceRouter);
  app.use("/wa", crmProspectRouter);
  app.use("/wa", crmDealRouter);
  app.use("/wa", crmQuoteRouter);
  app.use("/wa", crmUserRouter);
  app.use("/wa", crmProductRouter);
  app.use("/wa", emailRouter);
  app.use("/wa", messagingRouter);
  app.use("/wa", automationRuleRouter);
  app.use("/wa", adminUserRouter);

  // Authentification espace client (hors convention /wa — pas de DAO CRUD dédié)
  app.use("/api", authRouter);

  // Parcours d'inscription public (hors /wa — pas d'authentification requise,
  // c'est le point d'entrée qui en crée une)
  app.use(onboardingRouter);

  // Formulaire de contact du site web public (hors /wa — pas d'authentification,
  // alimente le CRM commercial interne)
  app.use(contactRouter);

  app.get("/health", (_req, res) => res.json({ ok: true, ...VERSION }));
  // Numéro de version (commit + date du build) — permet de vérifier depuis
  // le navigateur quel build tourne réellement après un déploiement.
  app.get("/version", (_req, res) => res.json(VERSION));
  // Journal des nouveautés/corrections par panneau (badges "New" dans la nav admin).
  app.get("/changelog", (_req, res) => res.json(CHANGELOG));

  // Apps statiques (HTML/CSS/JS d'origine, rebranchées sur l'API)
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "checkin.html")));
  app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));
  app.get("/onboarding", (_req, res) => res.sendFile(path.join(publicDir, "onboarding.html")));
  app.get("/crm", (_req, res) => res.sendFile(path.join(publicDir, "crm.html")));

  app.use(errorHandler);

  return app;
}
