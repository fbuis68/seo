# Signalements (« Signaler un problème »)

## Côté utilisateur

- Bouton **« ? Signaler un problème »** en bas à droite de chaque écran.
- Après une erreur serveur (5xx, réseau, conflit, introuvable), un bandeau propose « Signaler ce problème ».
- Formulaire :
  - type : bug, question ou évolution ;
  - gravité ;
  - « Que s'est-il passé ? » ;
  - « Qu'attendiez-vous ? » ;
  - case « Joindre les informations techniques ».
- Contexte joint automatiquement : écran, fonction (titre de l'écran et fenêtre ouverte), navigateur, 10 dernières erreurs serveur (méthode, adresse, code, message).
- Onglet « Mes signalements » : référence `TCK-00001`, état, réponse de l'éditeur.
- Email à l'utilisateur quand le ticket est clos (corrigé, non retenu, doublon).

## Côté éditeur (`/platform`, section « Signalements »)

- Email à chaque nouveau ticket, envoyé aux comptes `PLATFORM_ADMINS`.
- Liste triée par gravité.
- Détail : description, contexte, erreurs.
- Statut et réponse modifiables.
- **Récapitulatif** à transmettre pour correction :
  - **Excel**, 2 onglets : « Tickets » et « Erreurs techniques » ;
  - **Texte pour Claude (.md)**.
- Options du récapitulatif :
  - statut ;
  - date de début ;
  - seulement les tickets pas encore transmis ;
  - masquer les données personnelles (emails, téléphones, IBAN, n° de sécurité sociale, jetons) ;
  - marquer comme transmis.
- API : `GET /api/v1/platform/tickets/export?format=xlsx|md&status=open&onlyNew=true&anonymize=true&mark=true`.

## Cycle conseillé

1. Exporter « Texte pour Claude » chaque semaine, avec « seulement non transmis » et « marquer comme transmis ».
2. Déposer le fichier dans la session Claude Code : corrections, tests, push.
3. Mettre à jour le serveur, puis passer les tickets en « Corrigé » : l'utilisateur est prévenu.
