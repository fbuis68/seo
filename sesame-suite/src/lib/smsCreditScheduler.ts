import { prisma } from "../db";
import { fetchSmsPartnerCredit } from "./sms";
import { fireTrigger } from "./automation";

/**
 * Alerte "crédit SMS bas" (09/11/2026, demande client "inserer une trigger
 * pour alerter le client quand les credits atteignent un certain niveau")
 * — câblée sur le moteur d'automatisation générique (lib/automation.ts,
 * déclencheur "crm.sms_credit_low"), même principe que checkAndSendBankAlerts
 * (lib/accBankAlerts.ts) : le seuil se règle depuis le panneau
 * Automatisations (audienceFilter.maxCredit), pas un système d'alerte
 * dédié en dur.
 *
 * Contrairement aux événements "created" (un mouvement bancaire, un
 * prospect…), le crédit SMS est un NIVEAU qui peut redescendre sous le
 * seuil, remonter (recharge), puis redescendre à nouveau — chaque passage
 * sous le seuil doit pouvoir re-notifier. AutomationRuleLog dédoublonne de
 * façon DÉFINITIVE par (règle, cible) : on supprime donc nous-mêmes la
 * ligne de log dès que le crédit repasse au-dessus du seuil, pour
 * réautoriser un futur passage en dessous à re-déclencher fireTrigger.
 *
 * Intervalle volontairement plus long que les schedulers bancaires (15 min,
 * cf. qontoScheduler/gocardlessScheduler) : un crédit SMS ne varie pas vite
 * et chaque vérification interroge l'API SMSPartner pour de vrai — pas la
 * peine de la solliciter aussi souvent pour une seule valeur.
 */
const CHECK_INTERVAL_MS = 60 * 60_000; // 60 min

async function checkSmsCredits() {
  // Pas de règle configurée pour ce déclencheur : inutile d'interroger
  // l'API SMSPartner pour chaque client à chaque passage.
  let rules;
  try {
    rules = await prisma.automationRule.findMany({
      where: { trigger: "crm.sms_credit_low", enabled: true, timingMode: "immediate" },
    });
  } catch (err) {
    console.error("[smsCreditScheduler] lecture des règles échouée:", err);
    return;
  }
  if (!rules.length) return;

  let configs;
  try {
    configs = await prisma.channelConfig.findMany({
      where: { channel: "sms", provider: "smspartner", entityId: { not: null } },
      select: { entityId: true, apiKey: true, baseUrl: true },
    });
  } catch (err) {
    console.error("[smsCreditScheduler] lecture des configurations SMS échouée:", err);
    return;
  }

  for (const cfg of configs) {
    if (!cfg.apiKey || !cfg.entityId) continue;
    const result = await fetchSmsPartnerCredit(cfg.apiKey, cfg.baseUrl).catch((e) => {
      console.error(`[smsCreditScheduler] échec de lecture du crédit pour l'entité ${cfg.entityId}:`, e);
      return null;
    });
    if (!result || result.credit === null) continue;
    const credit = result.credit;

    // Fiche CRM du client propriétaire de cette entité — c'est ELLE qui
    // porte l'email/téléphone à notifier (recipientMode="event" par
    // défaut côté règle, comme crm.ticket_status_changed).
    const prospect = await prisma.crmProspect.findFirst({
      where: { entityId: cfg.entityId },
      select: { id: true, nom: true, email: true, tel: true },
    });
    if (!prospect) continue;

    for (const rule of rules) {
      const filter = (rule.audienceFilter || {}) as { maxCredit?: number };
      if (filter.maxCredit == null) continue; // pas de seuil réglé sur cette règle — rien à comparer

      if (credit > filter.maxCredit) {
        // Crédit remonté au-dessus du seuil — on efface le log pour
        // réautoriser une alerte la prochaine fois qu'il redescendra.
        await prisma.automationRuleLog
          .deleteMany({ where: { ruleId: rule.id, targetType: "crmProspect", targetId: prospect.id } })
          .catch((e) => console.error("[smsCreditScheduler] échec de réinitialisation du log:", e));
        continue;
      }

      await fireTrigger("crm.sms_credit_low", {
        entityId: null,
        targetType: "crmProspect",
        targetId: prospect.id,
        recipient: { email: prospect.email, phone: prospect.tel },
        matchData: { credit },
        variables: { nom: prospect.nom, credit: String(credit), seuil: String(filter.maxCredit) },
      }).catch((e) => console.error("[smsCreditScheduler] échec de la règle:", e));
    }
  }
}

export function startSmsCreditScheduler() {
  setInterval(() => {
    checkSmsCredits().catch((e) => console.error("[smsCreditScheduler] check failed:", e));
  }, CHECK_INTERVAL_MS);
  console.log("[smsCreditScheduler] démarré (vérification toutes les 60 min)");
}
