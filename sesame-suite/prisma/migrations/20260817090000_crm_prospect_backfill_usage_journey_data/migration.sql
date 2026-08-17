-- DataMigration : corrige les fiches CrmProspect créées AVANT l'ajout de
-- `code` et des 7 indicateurs de parcours (migration précédente) — sur une
-- base déjà provisionnée (docker-compose avec volume Postgres persistant),
-- ces colonnes arrivent avec leurs valeurs par défaut (0 / false) puisque
-- seed.ts n'insère les fiches de démonstration qu'une seule fois (garde
-- `count===0`) et ne les réécrase jamais ensuite. Cette migration corrige
-- donc les fiches existantes, une fois pour toutes (comme toute migration
-- Prisma, jamais rejouée sur une base qui l'a déjà appliquée) — sans risque
-- d'écraser une modification manuelle faite depuis dans l'app :
--   - les 7 indicateurs de parcours n'existaient pas avant cette version,
--     personne n'a donc pu les éditer manuellement ;
--   - les taux d'usage (nfc/mobile/code/qr) ne sont corrigés que sur les
--     fiches encore à 0 partout (WHERE ... = 0 sur les 4 colonnes).
-- Logique identique à sectorGroupFor()/journeyFlagsFor()/AUDIT_USAGE dans
-- prisma/seed.ts (qui couvre déjà correctement le cas d'une base neuve).

-- Identité et rubriques de l'espace client : universelles, tous secteurs.
UPDATE "CrmProspect" SET
  "onbIdentite" = true,
  "espBoutique" = true,
  "espPoint" = true,
  "espEvenement" = true;

-- Choix de la chambre / préférences ménage : secteurs hébergement
-- uniquement (tout secteur hors Sport/Garde meuble/Bureaux/Agence gestion
-- patrimoine, cf. sectorGroupFor() -> 'hotel').
UPDATE "CrmProspect" SET
  "onbChoixChambres" = true,
  "onbMenage" = true
WHERE "secteur" IS NULL OR "secteur" NOT IN ('Sport', 'Garde meuble', 'Bureaux', 'Agence gestion patrimoine');

-- Déclaration d'occupant : secteurs hébergement + Sport.
UPDATE "CrmProspect" SET
  "onbOccupant" = true
WHERE "secteur" IS NULL OR "secteur" NOT IN ('Garde meuble', 'Bureaux', 'Agence gestion patrimoine');

-- Vrais taux d'usage des accès (NFC/Mobile/Code/QR), issus de l'audit
-- clients Sesame (AUDIT_CLIENTS_SESAME_2025.xlsx) — uniquement les fiches
-- encore à 0 sur les 4 colonnes.
UPDATE "CrmProspect" SET "nfc"=100,"mobile"=0,"code"=0,"qr"=0 WHERE "nom"='1K' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=71,"code"=0,"qr"=29 WHERE "nom"='ACGP93' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=76,"code"=0,"qr"=24 WHERE "nom"='AKANTHA' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=20,"mobile"=0,"code"=0,"qr"=80 WHERE "nom"='ASEAT' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=100,"qr"=0 WHERE "nom"='ASTORG' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=15,"code"=0,"qr"=85 WHERE "nom"='ASTREA' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=18,"code"=82,"qr"=0 WHERE "nom"='AUBERG''INE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=17,"mobile"=14,"code"=0,"qr"=69 WHERE "nom"='Ambassadeur Lille' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=32,"code"=0,"qr"=68 WHERE "nom"='Appartements de Lille' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=18,"code"=0,"qr"=82 WHERE "nom"='Apparts de Marin' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=87,"mobile"=0,"code"=8,"qr"=5 WHERE "nom"='Auberge St Jacques' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=100,"mobile"=0,"code"=0,"qr"=0 WHERE "nom"='BELLEVAL' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=0,"qr"=100 WHERE "nom"='BUDA FITNESS' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=14,"code"=86,"qr"=0 WHERE "nom"='Beaujour & Bonsoir' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=55,"mobile"=23,"code"=0,"qr"=22 WHERE "nom"='Bedzzz Apartments' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=81,"mobile"=0,"code"=0,"qr"=19 WHERE "nom"='CHÂTEAU DU SOUZY' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=100,"qr"=0 WHERE "nom"='CITYZEN' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=99,"mobile"=0,"code"=0,"qr"=1 WHERE "nom"='COEURMANDIE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=30,"code"=0,"qr"=70 WHERE "nom"='COLOMBYA' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=59,"code"=0,"qr"=41 WHERE "nom"='COPWELL – Fédé. Natation' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=99,"mobile"=0,"code"=0,"qr"=1 WHERE "nom"='COPWELL – HAVAS' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=98,"code"=0,"qr"=2 WHERE "nom"='COPWELL – LARCO' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=0,"qr"=100 WHERE "nom"='DOJO BORDEAUX' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=98,"mobile"=0,"code"=0,"qr"=2 WHERE "nom"='DOMAINE DU BELVEDERE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=0,"qr"=100 WHERE "nom"='DYNAMIC SEVRES' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=1,"mobile"=0,"code"=99,"qr"=0 WHERE "nom"='ESCALE AU SOLEIL' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=1,"code"=99,"qr"=0 WHERE "nom"='FLORELLA' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=99,"mobile"=0,"code"=0,"qr"=1 WHERE "nom"='HOTEL DE FRANCE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=3,"code"=97,"qr"=0 WHERE "nom"='HOTEL MARIE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=20,"mobile"=0,"code"=0,"qr"=80 WHERE "nom"='KI SPACE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=100,"mobile"=0,"code"=0,"qr"=0 WHERE "nom"='KUBE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=3,"mobile"=20,"code"=0,"qr"=77 WHERE "nom"='LA PENICHE AIGUES MORTES' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=15,"mobile"=45,"code"=0,"qr"=40 WHERE "nom"='LA PENICHE HISSEO' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=22,"mobile"=22,"code"=0,"qr"=56 WHERE "nom"='LA PENICHE TOURNON' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=92,"code"=0,"qr"=8 WHERE "nom"='LA RUCHE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=97,"code"=0,"qr"=3 WHERE "nom"='LE VICTOR' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=100,"mobile"=0,"code"=0,"qr"=0 WHERE "nom"='LOUVRE PIEMONT' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=90,"mobile"=4,"code"=0,"qr"=6 WHERE "nom"='LYONNAIS NICE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=11,"code"=89,"qr"=0 WHERE "nom"='LocBox AVRANCHES' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=39,"code"=61,"qr"=0 WHERE "nom"='LocBox GRANVILLE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=9,"code"=0,"qr"=91 WHERE "nom"='MAB BOX' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=0,"qr"=100 WHERE "nom"='MAISON ROQUELONGUE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=4,"code"=0,"qr"=96 WHERE "nom"='MINA MINA' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=12,"mobile"=1,"code"=0,"qr"=87 WHERE "nom"='MMIP CHAMP DE MARS' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=7,"mobile"=3,"code"=0,"qr"=90 WHERE "nom"='MMIP CITE VERON' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=14,"mobile"=1,"code"=0,"qr"=85 WHERE "nom"='MMIP INVALIDES' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=62,"code"=0,"qr"=38 WHERE "nom"='MONTEFIORE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=28,"mobile"=0,"code"=0,"qr"=72 WHERE "nom"='PUC' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=99,"mobile"=0,"code"=0,"qr"=1 WHERE "nom"='QUEENS HOTEL PARIS' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=56,"mobile"=0,"code"=0,"qr"=44 WHERE "nom"='REGINA D''AVIGNON' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=15,"mobile"=10,"code"=0,"qr"=75 WHERE "nom"='ROSA HOTEL' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=90,"mobile"=0,"code"=10,"qr"=0 WHERE "nom"='ROYAL HOTEL TULLE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=87,"mobile"=8,"code"=0,"qr"=5 WHERE "nom"='SEM PAU' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=0,"code"=100,"qr"=0 WHERE "nom"='SEROTEL' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=17,"code"=0,"qr"=83 WHERE "nom"='VILLA CADIERE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=98,"mobile"=0,"code"=0,"qr"=2 WHERE "nom"='VILLAGE D+ CORREZE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=96,"mobile"=0,"code"=0,"qr"=4 WHERE "nom"='VILLAGE D+ VALLOIRE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=0,"mobile"=20,"code"=0,"qr"=80 WHERE "nom"='WELLBEE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
UPDATE "CrmProspect" SET "nfc"=100,"mobile"=0,"code"=0,"qr"=0 WHERE "nom"='YOU ARE DEAUVILLE' AND "nfc"=0 AND "mobile"=0 AND "code"=0 AND "qr"=0;
