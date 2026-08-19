-- Décoche les 7 options actives ("Choix chambre", "Occupant", "Identité",
-- "Ménage", "Boutique", "Points fidélité", "Évènements") sur toutes les
-- fiches client, à la demande explicite de l'utilisateur. Rejoué en
-- migration (plutôt qu'un simple script one-off) car un précédent
-- décochage fait uniquement en direct sur la base de dev n'a pas survécu à
-- un reset/reseed de l'environnement.
UPDATE "CrmProspect" SET
  "onbChoixChambres" = false,
  "onbOccupant" = false,
  "onbIdentite" = false,
  "onbMenage" = false,
  "espBoutique" = false,
  "espPoint" = false,
  "espEvenement" = false;
