# Widget d'ouverture de ticket support — à intégrer sur un site externe

Instructions pour l'équipe qui gère un site web externe (`sesame-technology.com`,
un site client en production…) : comment insérer le bouton flottant qui
permet aux visiteurs d'ouvrir un ticket support sans quitter la page.

## Ce que fait le widget

Un bouton flottant apparaît en bas de page. En cliquant dessus, un panneau
s'ouvre avec un petit formulaire (email, nom, sujet, message, pièce jointe
optionnelle). À l'envoi :

- un **ticket** est créé côté CRM Sesame (`/crm`, panneau **Tickets**),
  rattaché à une fiche prospect/client existante ou nouvellement créée —
  exactement comme `public/support.html`, dont ce widget réutilise le même
  point d'entrée ;
- le visiteur reçoit un lien de suivi (page `/support?token=...`) pour
  revenir compléter ou suivre son ticket plus tard.

Aucune configuration côté CRM n'est nécessaire : le endpoint est déjà actif.

## Intégration — une seule balise

Ajoutez ceci n'importe où dans le HTML du site (juste avant `</body>` de
préférence) :

```html
<script src="https://<domaine-du-serveur-sesame-suite>/ticketWidget.js" async></script>
```

Remplacez `<domaine-du-serveur-sesame-suite>` par l'URL du serveur où
Sesame Suite est déployé. Le widget est entièrement autonome (pas d'autre
fichier à charger, pas de dépendance) et isole son propre CSS (Shadow DOM)
pour ne jamais entrer en conflit avec le style du site qui l'accueille.

## Personnalisation (facultative)

Tous les réglages se font via des attributs `data-*` sur la même balise :

```html
<script
  src="https://<domaine-du-serveur-sesame-suite>/ticketWidget.js"
  data-label="Nous contacter"
  data-title="Une question ?"
  data-color="#1a4880"
  data-position="bottom-left"
  data-subject="Question facturation"
  async
></script>
```

| Attribut         | Effet                                                              | Défaut               |
|-------------------|---------------------------------------------------------------------|-----------------------|
| `data-label`     | Texte affiché sur le bouton flottant (vide = icône seule)          | `Support`             |
| `data-title`     | Titre affiché en haut du panneau                                    | `Besoin d'aide ?`     |
| `data-color`     | Couleur d'accent (bouton, en-tête, liens)                            | `#8a2b2b`              |
| `data-position`  | `bottom-right` ou `bottom-left`                                     | `bottom-right`         |
| `data-subject`   | Pré-remplit le champ Sujet — utile sur une page dédiée à un thème   | (vide)                 |
| `data-api-base`  | URL de l'API si différente de l'origine du script (cas avancé)      | déduite du `src`       |

## Où voir le résultat

Dans `/crm` → panneau **Tickets**, le nouveau ticket apparaît avec le
statut "En attente". Les réponses envoyées depuis le CRM partent par email
au visiteur ; s'il répond directement à cet email et que l'import
automatique Microsoft Graph est activé (cf.
`docs/microsoft-graph-inbound-tickets.md`), sa réponse est rattachée au
même ticket automatiquement.

## Tester avant mise en production

`public/ticketWidget-demo.html` simule une page externe qui embarque le
widget — ouvrez `https://<domaine-du-serveur-sesame-suite>/ticketWidget-demo.html`
pour vérifier son apparence et soumettre un ticket de test.
