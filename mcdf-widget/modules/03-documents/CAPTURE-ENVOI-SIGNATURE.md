# Capture réseau : envoi de document / signature électronique

Objectif : trouver la vraie requête que MCDF envoie quand on clique sur
"Envoyer"/"Signer électroniquement" (ou libellé équivalent), pour pouvoir
la déclencher depuis le widget IA une fois confirmée. Comme pour toutes
les entités du projet, on ne devine pas l'endpoint — on le capture.

**⚠️ À faire sur un dossier/convention de TEST, pas sur un vrai client** :
cette action a un effet réel (un document part vraiment vers quelqu'un).

## Procédure

1. Se connecter à MCDF (idéalement sur l'entité DEMO ou une entité de test).
2. Ouvrir DevTools (**F12**) → onglet **Network**. Cocher **Preserve log**
   (en haut de l'onglet Network) — utile si l'action déclenche une
   redirection, pour ne pas perdre la requête.
3. Ouvrir un **Dossier** (convention) existant, si possible avec un
   document déjà généré (onglet "Document(s)" / "Document attaché" —
   c'est là qu'on avait repéré `conventionDocumentDao` dans le code).
4. Chercher le bouton d'envoi/signature — le libellé exact n'est pas
   connu à l'avance, ça peut être : "Envoyer", "Envoyer par email",
   "Signer électroniquement", "Demander signature", une icône enveloppe
   ou stylo. Si plusieurs boutons existent (envoi simple ET signature),
   capturer chaque cas séparément (répéter les étapes 5-6 pour chacun).
5. Cliquer sur le bouton **avec un destinataire de test si demandé**
   (votre propre email par exemple, pas un vrai client).
6. Dans l'onglet Network, repérer la requête qui vient d'apparaître —
   filtrer par **Fetch/XHR** et chercher un mot-clé dans l'URL du type
   `send`, `sign`, `mail`, `document`, `signature`.
7. Pour cette requête, noter/copier :
   - **Méthode** (GET/POST/PUT)
   - **URL complète**
   - **Payload** (onglet "Payload"/"Request" — le corps envoyé : id du
     document, destinataire, etc.)
   - **Réponse** (onglet "Response" — succès ? lien de suivi ? id créé ?)
   - Si ça redirige vers un **autre domaine** (ex: un prestataire de
     signature électronique comme Yousign/DocuSign/Universign), c'est
     une information cruciale à noter aussi — ça changerait complètement
     l'architecture (MCDF ne ferait qu'initier, le vrai flux de signature
     se passerait ailleurs).

## À transmettre dans la conversation

Coller ici le résultat de l'étape 7 (méthode + URL + payload + réponse,
pour chaque bouton testé). Sur cette base, le widget pourra proposer un
vrai déclenchement d'envoi/signature, avec confirmation explicite avant
toute action (cohérent avec le reste du projet : aucune écriture sans
validation humaine).
