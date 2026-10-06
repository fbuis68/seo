=== TMS — Souscription en ligne ===
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPL-2.0-or-later

Intègre la grille tarifaire, le configurateur de modules et l'inscription en ligne de l'application de gestion de centre de formation.

== Installation ==
1. Copier le dossier `tms-souscription` dans `wp-content/plugins/` puis activer l'extension.
2. Réglages → Souscription en ligne : saisir l'URL de l'API (ex. https://api.exemple.fr).
3. Côté API, ajouter le domaine du site dans `PUBLIC_ORIGINS` (CORS).
4. Insérer un shortcode dans la page « Tarifs » :
   * `[tms_souscription]` — tarifs + modules + inscription
   * `[tms_tarifs interval="year"]`, `[tms_modules]`, `[tms_inscription plan="equipe"]`

== Fonctionnement ==
* Les tarifs sont rendus côté serveur (cache 1 h) pour le référencement, avec données structurées schema.org, puis remplacés par le widget interactif.
* L'inscription crée un espace Free sans carte ; l'offre payante choisie est finalisée par paiement hébergé après confirmation de l'email. Aucun montant n'est transmis par le navigateur.
* Événement `tms_signup` poussé dans `dataLayer` (Google Tag Manager) pour le suivi des conversions.
