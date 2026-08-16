/**
 * Journal des nouveautés/corrections par panneau du back-office — consommé
 * par `GET /changelog` pour afficher un badge "New" dynamique dans la nav
 * de `public/admin.html` (au lieu d'un badge statique codé en dur).
 *
 * `panel` doit correspondre à un `data-pan` de la nav (public/admin.html).
 * Le badge s'affiche tant que l'entrée la plus récente d'un panneau a moins
 * de 21 jours (voir NEW_BADGE_MAX_AGE_DAYS côté front) — pas de mécanisme
 * de "vu/pas vu" à gérer, l'ancienneté suffit à faire disparaître le badge.
 *
 * Convention : à chaque correction/amélioration notable d'un panneau,
 * ajouter une entrée ici avec une explication orientée utilisateur (le
 * "quoi" et le "pourquoi ça vous concerne"), pas un message de commit.
 */
export interface ChangelogEntry {
  panel: string;
  date: string; // YYYY-MM-DD
  title: string;
  body: string;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    panel: "reservations",
    date: "2026-08-16",
    title: "Nouveau : arrivées du jour",
    body: "Nouvelle rubrique listant les réservations qui arrivent aujourd'hui, avec les options retenues par chaque client au check-in éco (ménage, boutique/room service, taxe de séjour).",
  },
  {
    panel: "dash",
    date: "2026-08-16",
    title: "Back-office responsive",
    body: "Le back-office s'adapte maintenant aux écrans étroits (mobile/tablette) : menu latéral en tiroir accessible depuis l'icône ☰.",
  },
  {
    panel: "automation",
    date: "2026-08-16",
    title: "Réglage temporel harmonisé",
    body: "Les délais avant/après un événement (début de séjour, fin de séjour, fin d'essai…) se règlent maintenant avec un seul réglage Sens + Délai + Unité (minutes, heures, jours ou mois) — ex. J-5, H-10, M+1 — identique sur tous les déclencheurs à date pivot.",
  },
  {
    panel: "automation",
    date: "2026-08-15",
    title: "Diagnostic des règles + nouveaux déclencheurs",
    body: "Chaque règle affiche désormais la raison précise d'un envoi manqué (ex. destinataire sans email) et propose un bouton \"Tester\" pour vérifier une règle immédiatement. Nouveaux déclencheurs : commande annulée, souscription activée/annulée.",
  },
  {
    panel: "email",
    date: "2026-08-15",
    title: "Correction : configuration parfois non enregistrée",
    body: "Corrige un bug où la configuration d'un canal (SMTP, SMS, WhatsApp) pouvait sembler ne pas s'enregistrer après un double-clic sur Enregistrer — la bonne configuration est maintenant toujours utilisée.",
  },
];
