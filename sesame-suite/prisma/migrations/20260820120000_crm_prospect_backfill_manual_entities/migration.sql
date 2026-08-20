-- Crée une fiche CrmProspect pour chaque Entity (hors SESAME-HQ) qui n'en a
-- encore aucune — cas des établissements provisionnés manuellement par
-- Sesame HQ (panneau "Hôtels [Multi]"), qui jusqu'ici ne créait aucun lien
-- CRM (contrairement à l'inscription en ligne). Sans cette fiche, le CRM ne
-- peut pas retrouver la langue/devise/fuseau de l'établissement (lus en
-- direct via entityId -> EntityModuleConfig, cf. crmProspect.ts).
INSERT INTO "CrmProspect" (
  id, "entityId", nom, type, secteur, danger, contrat, modules, email,
  "webApp", checkin, messagerie, "createdAt", "updatedAt"
)
SELECT
  substr(md5(random()::text || clock_timestamp()::text || e.id), 1, 25),
  e.id,
  COALESCE(emc."hotelName", e.name),
  'Client',
  'Hôtellerie',
  'Modéré',
  'en cours',
  0,
  au.email,
  true,
  true,
  'Noreply',
  now(),
  now()
FROM "Entity" e
LEFT JOIN "EntityModuleConfig" emc ON emc."entityId" = e.id
LEFT JOIN LATERAL (
  SELECT email FROM "AdminUser" WHERE "entityId" = e.id ORDER BY "createdAt" ASC LIMIT 1
) au ON true
WHERE e.code <> 'SESAME-HQ'
  AND NOT EXISTS (SELECT 1 FROM "CrmProspect" cp WHERE cp."entityId" = e.id);
