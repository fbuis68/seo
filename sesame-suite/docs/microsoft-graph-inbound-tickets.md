# Tickets automatiques depuis les emails entrants (Microsoft Graph)

Procédure pour activer l'import automatique des emails reçus sur la boîte
support en tickets Sesame Suite (panneau **Tickets**, `/crm`), sans règle
Outlook ni flux Power Automate — remplacé ici par un abonnement webhook
Microsoft Graph natif, sans coût supplémentaire (utilise l'abonnement
Microsoft 365 déjà en place).

**Principe** : chaque nouvel email reçu dans la boîte support déclenche une
notification vers Sesame Suite, qui va chercher le contenu du message via
l'API Graph, puis crée un ticket (ou complète un ticket existant si le
sujet contient la référence `[#xxxxxx]` insérée par Sesame Suite dans ses
propres réponses).

---

## Étape 0 — Qui peut faire cette manipulation ?

Il faut un compte **administrateur** du tenant Microsoft 365/Entra ID
`sesame-technology.com` avec le rôle **Administrateur d'application**
(Application administrator) ou **Administrateur général** (Global
administrator). Si vous n'avez pas ce rôle, transmettez cette procédure à
votre service IT ou prestataire informatique.

---

## Étape 1 — Créer l'inscription d'application (App registration)

1. Allez sur **https://entra.microsoft.com** (ou https://portal.azure.com
   → "Microsoft Entra ID"), connectez-vous avec votre compte administrateur.
2. Dans le menu de gauche, **Identité** (Identity) → **Applications** →
   **Inscriptions d'applications** (App registrations).
3. Cliquez **"+ Nouvelle inscription"** (New registration).
4. Renseignez :
   - **Nom** : `Sesame Suite - Tickets support` (libre, sert juste à
     identifier l'app dans la liste).
   - **Types de comptes pris en charge** : "Comptes dans cet annuaire
     d'organisation uniquement" (Single tenant).
   - **URI de redirection** : laissez vide (cette app n'authentifie aucun
     utilisateur, elle s'authentifie elle-même — cf. étape 3).
5. Cliquez **"S'inscrire"** (Register).
6. Sur la page qui s'ouvre, notez tout de suite (vous en aurez besoin à
   l'étape 4) :
   - **ID d'application (client)** (Application (client) ID)
   - **ID d'annuaire (locataire)** (Directory (tenant) ID)

---

## Étape 2 — Accorder la permission `Mail.Read` (Application)

1. Toujours sur la page de l'app, menu de gauche : **API autorisées**
   (API permissions).
2. Cliquez **"+ Ajouter une autorisation"** (Add a permission).
3. Choisissez **Microsoft Graph**, puis **"Autorisations d'application"**
   (Application permissions) — **pas** "Autorisations déléguées" (Delegated
   permissions), puisqu'aucun utilisateur ne se connecte : c'est
   l'application elle-même qui doit avoir le droit de lire la boîte.
4. Recherchez **`Mail.Read`**, cochez-la, puis **"Ajouter des
   autorisations"** (Add permissions).
5. De retour sur la liste, cliquez **"Accorder un consentement admin pour
   [nom du tenant]"** (Grant admin consent for ...), confirmez. La ligne
   `Mail.Read` doit passer au statut vert **"Accordé"** (Granted).

⚠️ Sans cette dernière étape de consentement admin, l'application est
inscrite mais ne peut rien lire — c'est l'erreur la plus fréquente.

---

## Étape 3 — Créer le secret client (client credentials)

1. Menu de gauche : **Certificats et secrets** (Certificates & secrets).
2. Onglet **Secrets clients** (Client secrets) → **"+ Nouveau secret
   client"** (New client secret).
3. Description libre (ex : `sesame-suite-prod`), expiration **24 mois**
   (le maximum proposé — au-delà, le secret doit être régénéré et
   `GRAPH_CLIENT_SECRET` mis à jour, sans quoi l'import s'arrête).
4. Cliquez **"Ajouter"** (Add).
5. **Copiez immédiatement la colonne "Valeur" (Value)** — elle n'est
   affichée qu'une seule fois, impossible de la revoir ensuite (il faudra
   recréer un secret si elle est perdue).

---

## Étape 4 — Restreindre l'accès à la seule boîte support (recommandé)

Par défaut, la permission `Mail.Read` en mode Application donne accès à
**toutes les boîtes du tenant**, pas seulement à la boîte support — cette
app n'a besoin de lire qu'une seule adresse. Microsoft recommande de
restreindre cet accès via une **stratégie d'accès aux applications**
(Application Access Policy), en PowerShell Exchange Online :

```powershell
Install-Module -Name ExchangeOnlineManagement   # si pas déjà installé
Connect-ExchangeOnline -UserPrincipalName vous@sesame-technology.com

# Remplacez <ID d'application> par l'"ID d'application (client)" noté à
# l'étape 1, et l'adresse par la boîte support réellement utilisée.
New-ApplicationAccessPolicy `
  -AppId "<ID d'application>" `
  -PolicyScopeGroupId "support@sesame-technology.com" `
  -AccessRight RestrictAccess `
  -Description "Sesame Suite - accès limité à la boîte support"

# Vérification :
Test-ApplicationAccessPolicy -AppId "<ID d'application>" -Identity "support@sesame-technology.com"
# Doit répondre AccessCheckResult : Granted
Test-ApplicationAccessPolicy -AppId "<ID d'application>" -Identity "unautrecompte@sesame-technology.com"
# Doit répondre AccessCheckResult : Denied
```

Cette étape est facultative pour que l'intégration fonctionne, mais
fortement recommandée : sans elle, un secret client compromis donnerait
accès en lecture à **toutes** les boîtes du tenant plutôt qu'à la seule
boîte support.

---

## Étape 5 — Configurer Sesame Suite

1. Dans les variables d'environnement du serveur (`.env` en local, ou la
   configuration de votre hébergeur en production), renseignez :
   ```
   GRAPH_TENANT_ID="<ID d'annuaire (locataire) noté à l'étape 1>"
   GRAPH_CLIENT_ID="<ID d'application (client) noté à l'étape 1>"
   GRAPH_CLIENT_SECRET="<valeur du secret copiée à l'étape 3>"
   ```
2. Vérifiez que `PUBLIC_BASE_URL` pointe bien vers l'URL publique HTTPS du
   serveur (ex : `https://app.sesame-technology.com`) — Microsoft Graph
   doit pouvoir atteindre cette adresse pour livrer les notifications.
3. Redémarrez le serveur pour que les nouvelles variables soient prises en
   compte.
4. Dans `/crm` → panneau **Canaux**, vérifiez que le champ **"Adresse
   support"** de la carte "Serveur SMTP sortant" correspond bien à la boîte
   que vous venez d'autoriser (ex : `support@sesame-technology.com`) — c'est
   cette adresse que Sesame Suite surveille, à l'exclusion de toute autre.
5. Sur la nouvelle carte **"Tickets par email entrant (Microsoft Graph)"**,
   cliquez **"Activer"**.

## Vérifier que ça fonctionne

Envoyez un email de test à l'adresse support depuis une boîte externe.
Un ticket portant ce sujet doit apparaître dans le panneau **Tickets**
en quelques secondes. Si rien n'apparaît :

- Revérifiez le statut affiché sur la carte "Tickets par email entrant"
  (un message d'erreur y est affiché le cas échéant).
- Confirmez que le consentement admin de l'étape 2 est bien accordé (statut
  vert) — c'est la cause la plus fréquente d'échec silencieux.
- Si une stratégie d'accès a été posée à l'étape 4, revérifiez avec
  `Test-ApplicationAccessPolicy` qu'elle autorise bien la boîte support
  configurée à l'étape 5.

## Remarque sur le renouvellement

Microsoft Graph limite la durée d'un abonnement sur les emails à environ
3 jours — Sesame Suite le renouvelle automatiquement toutes les heures
(cf. `lib/graphSubscriptionScheduler.ts`), sans action de votre part tant
que le serveur reste en fonctionnement. Un arrêt prolongé du serveur (plus
de 3 jours) nécessite de recliquer "Activer" au redémarrage.
