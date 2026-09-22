import { createApp } from "./app";
import { config } from "./config";
import { startBookingSourceScheduler } from "./lib/bookingSourceScheduler";
import { startLockerSourceScheduler } from "./lib/lockerSourceScheduler";
import { startAutomationScheduler } from "./lib/automationScheduler";
import { startCampaignScheduler } from "./lib/campaignScheduler";
import { startGraphSubscriptionScheduler } from "./lib/graphSubscriptionScheduler";
import { startQontoScheduler } from "./lib/qontoScheduler";
import { startGoCardlessScheduler } from "./lib/gocardlessScheduler";
import { startAccRelanceScheduler } from "./lib/accRelanceScheduler";
import { VERSION } from "./lib/version";

const INSECURE_DEFAULTS: Record<string, string> = {
  JWT_SECRET: "change-me-in-production",
  INBOUND_EMAIL_SECRET: "change-me-in-production",
};

/**
 * Garde-fou secrets — cf. audit sécurité du 15/09/2026 : docker-compose.yml
 * fixait littéralement JWT_SECRET="change-me-in-production", une valeur
 * publique (visible de quiconque lit ce dépôt) qui aurait permis de forger
 * un token admin pour N'IMPORTE QUEL établissement (ou le rôle "sesame"
 * lui-même) si jamais utilisée telle quelle en production. Avertit
 * bruyamment dans tous les cas (visible dans les logs au redémarrage) ;
 * refuse de démarrer si NODE_ENV=production ET qu'un défaut connu est
 * encore utilisé — un déploiement qui n'a pas encore défini NODE_ENV=
 * production n'est donc jamais cassé par ce garde-fou tant que l'opérateur
 * ne l'a pas explicitement activé.
 */
function checkSecrets() {
  const isProd = process.env.NODE_ENV === "production";
  for (const [envVar, insecureValue] of Object.entries(INSECURE_DEFAULTS)) {
    const value = process.env[envVar];
    if (!value || value === insecureValue) {
      const msg = `[sécurité] ${envVar} n'est pas défini (ou utilise encore la valeur par défaut publique "${insecureValue}") — générez une valeur aléatoire forte (ex : openssl rand -hex 32) et définissez-la en variable d'environnement AVANT tout déploiement exposé publiquement. Voir .env.example.`;
      if (isProd) throw new Error(msg);
      console.warn(`⚠️  ${msg}`);
    }
  }
}
checkSecrets();

const app = createApp();

app.listen(config.port, () => {
  console.log(`Sesame Suite server listening on http://localhost:${config.port}`);
  console.log(`Version : ${VERSION.sha} (build du ${VERSION.buildTime})`);
  startBookingSourceScheduler();
  startLockerSourceScheduler();
  startAutomationScheduler();
  startCampaignScheduler();
  startGraphSubscriptionScheduler();
  startQontoScheduler();
  startGoCardlessScheduler();
  startAccRelanceScheduler();
});
