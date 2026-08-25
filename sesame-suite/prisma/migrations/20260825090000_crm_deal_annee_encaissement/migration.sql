-- CrmDeal.moisEncaissement (0-11) seul ne distingue pas deux affaires
-- attendues le même mois d'années différentes (ex. Octobre 2026 vs Octobre
-- 2027) : elles se retrouvaient additionnées dans le même mois de la
-- Trésorerie affichée, quelle que soit l'année consultée. anneeEncaissement
-- lève l'ambiguïté ; les affaires déjà en base restent NULL et sont
-- traitées côté client comme l'année civile en cours au moment du calcul
-- (cf. dealEncaissementYear() dans crm.html).
ALTER TABLE "CrmDeal" ADD COLUMN "anneeEncaissement" INTEGER;
