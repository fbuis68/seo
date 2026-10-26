# Réunions Teams depuis une fiche prospect (Microsoft Graph)

Procédure pour activer la création de réunions Teams, la récupération du
transcript/enregistrement et le résumé IA depuis une fiche prospect du CRM
(`/crm`, carte **Réunions Teams**). Réutilise la **même** inscription
d'application Microsoft Entra ID que l'import automatique des tickets
support (`docs/microsoft-graph-inbound-tickets.md`) — mêmes
`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`, pas de nouvelle
app à créer. Il suffit d'ajouter des permissions à l'app existante.

---

## Étape 0 — Qui peut faire cette manipulation ?

Même pré-requis que pour les tickets : un compte **administrateur** du
tenant Microsoft 365/Entra ID, rôle **Administrateur d'application** ou
**Administrateur général**.

---

## Étape 1 — Ajouter les permissions à l'app existante

1. **https://entra.microsoft.com** → **Identité** → **Applications** →
   **Inscriptions d'applications** → ouvrez l'app `Sesame Suite - Tickets
   support` (ou le nom donné à l'époque).
2. Menu de gauche : **API autorisées** (API permissions).
3. **"+ Ajouter une autorisation"** → **Microsoft Graph** →
   **"Autorisations d'application"** (toujours application, jamais
   déléguée — aucun utilisateur ne se connecte).
4. Ajoutez, une par une (rechercher le nom, cocher, "Ajouter des
   autorisations") :
   - **`OnlineMeetings.ReadWrite.All`** — créer la réunion au nom du
     commercial organisateur.
   - **`OnlineMeetingRecording.Read.All`** — lire la liste et le contenu
     des enregistrements après la réunion.
   - **`OnlineMeetingTranscript.Read.All`** — lire la liste et le contenu
     des transcripts après la réunion.
   - **`User.Read.All`** — si pas déjà présente : nécessaire pour résoudre
     l'email du commercial connecté vers son identifiant Microsoft Graph
     (`GET /users/{email}`), requis par les trois permissions ci-dessus.
5. **"Accorder un consentement admin pour [nom du tenant]"** — les 4
   lignes (3 nouvelles + `User.Read.All`) doivent passer au statut vert
   **"Accordé"**.

⚠️ Sans ce consentement admin, les boutons "Planifier une réunion" et
"Récupérer le compte-rendu" échoueront avec une erreur 401/403 explicite
(jamais silencieuse).

---

## Étape 2 — Vérifier que l'enregistrement/la transcription sont activables

Ces permissions autorisent l'app à *créer* la réunion avec enregistrement
permis et à *lire* enregistrement/transcript une fois produits — elles ne
forcent **jamais** le démarrage automatique de l'enregistrement ni de la
transcription pendant la réunion. Deux cas :

- **Votre tenant a déjà une politique de réunion Teams avec
  enregistrement/transcription automatiques** (Teams Admin Center →
  Réunions → Politiques de réunion → l'organisateur a `AutoRecording`/
  `AutoTranscription` activés) : rien à faire, ça marche déjà pour toute
  réunion créée par ce compte.
- **Sinon** : l'organisateur (le commercial, via son propre compte Teams)
  doit cliquer **"Démarrer l'enregistrement"** / **"Démarrer la
  transcription"** pendant la réunion — l'app le rappelle dans la modale de
  création. Pas de solution 100% automatique sans cette politique tenant.

---

## Étape 3 — Vérifier la licence Transcription

La transcription Teams (pas seulement l'enregistrement vidéo) nécessite une
licence Microsoft 365/Teams qui l'inclut (Teams Premium, ou incluse dans
certains forfaits E3/E5 selon la date de souscription — vérifiez auprès de
votre administrateur licences si le bouton "Récupérer le compte-rendu"
renvoie systématiquement "Aucun transcript disponible" alors que la
réunion a bien eu lieu et que la transcription a été démarrée).

---

## Étape 4 — Tester

1. Depuis une fiche prospect du CRM, **"+ Planifier"** une réunion Teams
   (le commercial connecté doit avoir une vraie boîte Microsoft 365 dans ce
   tenant — c'est son email CRM qui est utilisé comme organisateur).
2. Rejoignez la réunion créée, démarrez enregistrement + transcription si
   votre tenant ne le fait pas automatiquement (étape 2), parlez quelques
   minutes, terminez la réunion.
3. Attendez quelques minutes (le transcript met du temps à être prêt côté
   Microsoft) puis cliquez **"Récupérer le compte-rendu"** sur la fiche —
   doit afficher résumé + points d'action, et un lien "▶ Enregistrement" si
   la vidéo est disponible.

Si l'étape 4.3 échoue de façon répétée après plusieurs minutes d'attente,
revérifiez l'étape 3 (licence) avant de soupçonner les permissions.
