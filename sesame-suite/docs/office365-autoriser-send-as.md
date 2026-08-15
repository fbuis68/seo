# Autoriser l'envoi "Send As" dans Microsoft 365 (Exchange Online)

Procédure pour corriger l'erreur rencontrée lors du test d'envoi depuis Sesame Suite :

```
554 5.2.252 SendAsDenied; noreply@sesame-technology.com not allowed to
send as villa@sesame-technology.com
```

**Ce que ça signifie** : le compte SMTP configuré dans Sesame Suite
(`noreply@sesame-technology.com`, celui utilisé pour l'authentification)
essaie d'envoyer des emails avec l'adresse d'expéditeur
`villa@sesame-technology.com`. Exchange Online refuse ça par défaut — c'est
une protection anti-usurpation. Deux solutions possibles ; la procédure
ci-dessous détaille la première (recommandée si vous voulez garder
`villa@sesame-technology.com` comme adresse visible par les destinataires).

Si `villa@sesame-technology.com` n'a pas besoin d'apparaître comme
expéditeur, la solution la plus simple est de changer le champ **"Email
d'expéditeur"** dans le panneau Email de Sesame Suite pour qu'il soit
identique à l'identifiant SMTP (`noreply@sesame-technology.com`) — aucune
manipulation Microsoft 365 requise dans ce cas.

---

## Étape 0 — Qui peut faire cette manipulation ?

Il faut un compte **administrateur global** ou **administrateur Exchange**
du tenant Microsoft 365 `sesame-technology.com`. Si vous n'avez pas ce
rôle, transmettez cette procédure à la personne qui gère votre Microsoft
365 (souvent le service IT ou le prestataire informatique).

---

## Méthode A — Si `villa@sesame-technology.com` est une boîte partagée (recommandé, le plus simple)

C'est le cas le plus courant pour une adresse comme `villa@` qui n'est pas
nominative. La procédure est entièrement dans l'interface moderne, sans
PowerShell.

1. Ouvrez un navigateur et allez sur **https://admin.microsoft.com**,
   connectez-vous avec votre compte administrateur.
2. Dans le menu de gauche, cliquez sur **"Teams et groupes"** (Teams &
   groups), puis sur **"Boîtes aux lettres partagées"** (Shared mailboxes).
   — Si vous ne voyez pas cette entrée, cliquez d'abord sur **"Afficher
   tout"** (Show all) en bas du menu de gauche pour déplier la liste
   complète.
3. Dans la liste, cliquez sur la ligne **`villa@sesame-technology.com`**
   pour ouvrir son panneau de détail (il s'ouvre sur le côté droit de
   l'écran).
4. Dans ce panneau, cliquez sur l'onglet **"Délégation de la boîte aux
   lettres"** (Mailbox delegation).
5. Vous voyez deux sections : **"Envoyer en tant que"** (Send as) et
   **"Envoyer de la part de"** (Send on behalf). C'est la première qui nous
   intéresse ici (elle fait apparaître les emails comme envoyés
   directement par `villa@sesame-technology.com`, sans mention "de la part
   de").
6. Sous **"Envoyer en tant que"**, cliquez sur **"Modifier les
   autorisations d'envoi en tant que"** (Edit Send as permissions), ou sur
   le **"+"** si c'est la première fois que la section est configurée.
7. Dans la fenêtre qui s'ouvre, cliquez sur **"+ Ajouter des
   autorisations"** (Add permissions).
8. Tapez **`noreply`** dans le champ de recherche, sélectionnez le compte
   **`noreply@sesame-technology.com`** dans les résultats, puis cliquez sur
   **"Ajouter"** (Add).
9. Cliquez sur **"Fermer"** (Close) pour valider, puis à nouveau
   **"Fermer"** pour quitter le panneau de détail de la boîte partagée.

La permission est en général active en quelques minutes, mais peut prendre
**jusqu'à 60 minutes** à se propager dans Exchange Online. Retentez le
test d'envoi depuis Sesame Suite après ce délai.

---

## Méthode B — Si `villa@sesame-technology.com` est une boîte utilisateur classique (licence individuelle)

Le nouveau centre d'administration n'expose pas toujours la délégation
"Send As" pour les boîtes utilisateur individuelles — dans ce cas, passez
par le **centre d'administration Exchange (EAC)**, plus complet.

1. Depuis **https://admin.microsoft.com**, dans le menu de gauche, allez
   tout en bas sur **"Centres d'administration"** (Admin centers), puis
   cliquez sur **"Exchange"**. Une nouvelle page s'ouvre (le centre
   d'administration Exchange, EAC).
2. Dans le menu de gauche de l'EAC, cliquez sur **"Destinataires"**
   (Recipients), puis sur **"Boîtes aux lettres"** (Mailboxes).
3. Recherchez et cliquez sur **`villa@sesame-technology.com`** dans la
   liste pour ouvrir son panneau de détail.
4. Dans ce panneau, cliquez sur l'onglet **"Délégation"** (Delegation).
5. Sous la section **"Envoyer en tant que"** (Send as), cliquez sur le
   **"+"**.
6. Dans la fenêtre de sélection, cherchez et sélectionnez
   **`noreply@sesame-technology.com`**, cliquez sur **"Ajouter"** (Add) en
   bas, puis **"OK"**.
7. Cliquez sur **"Enregistrer"** (Save) pour valider les modifications sur
   la boîte `villa@sesame-technology.com`.

Même délai de propagation qu'en méthode A (jusqu'à 60 minutes).

---

## Méthode C — PowerShell (pour un administrateur à l'aise avec la ligne de commande)

Si les interfaces graphiques ci-dessus ne sont pas accessibles (droits
insuffisants sur certains menus, tenant avec des restrictions), la
commande PowerShell suivante accomplit exactement la même chose :

1. Installez le module si nécessaire :
   ```powershell
   Install-Module -Name ExchangeOnlineManagement
   ```
2. Connectez-vous :
   ```powershell
   Connect-ExchangeOnline -UserPrincipalName vous@sesame-technology.com
   ```
   (une fenêtre de connexion Microsoft s'ouvre — authentifiez-vous avec un
   compte administrateur).
3. Accordez la permission :
   ```powershell
   Add-RecipientPermission "villa@sesame-technology.com" -Trustee "noreply@sesame-technology.com" -AccessRights SendAs -Confirm:$false
   ```
4. Vérifiez que la permission est bien appliquée :
   ```powershell
   Get-RecipientPermission "villa@sesame-technology.com" | Where-Object {$_.Trustee -like "*noreply*"}
   ```
   La commande doit afficher une ligne avec `AccessRights : {SendAs}`.

---

## Vérifier que ça fonctionne

Une fois la permission accordée (et le délai de propagation passé) :

1. Ouvrez `/crm` (ou le panneau **"Serveur email"** du back-office hôtel
   concerné).
2. Dans la carte **"Serveur SMTP sortant"**, saisissez une adresse dans le
   champ **"destinataire@test.com"** puis cliquez sur **"Envoyer un
   test"**.
3. Si tout est en ordre, un message **"Email de test envoyé à ..."**
   s'affiche. Si l'erreur `SendAsDenied` persiste après plus d'une heure,
   revérifiez que le compte sélectionné à l'étape 8 (méthode A) ou 6
   (méthode B) est bien `noreply@sesame-technology.com` — une faute de
   frappe ou un mauvais compte sélectionné est la cause la plus fréquente.

## Remarque sur l'identifiant SMTP vs l'adresse d'expéditeur

Dans le panneau **"Serveur email"** de Sesame Suite, deux champs sont
distincts et jouent des rôles différents :

- **"Identifiant"** = le compte qui s'authentifie auprès du serveur SMTP
  (`noreply@sesame-technology.com`) — celui dont le mot de passe est
  utilisé pour se connecter.
- **"Email d'expéditeur"** = l'adresse `From:` qui apparaît dans la boîte
  de réception du destinataire (`villa@sesame-technology.com`).

C'est précisément ce couple (authentification ≠ adresse d'expéditeur) que
la permission "Send As" autorise. Si un jour l'identifiant SMTP change
(nouveau compte de service, autre mot de passe), il faudra réaccorder la
permission "Send As" pour ce nouveau compte sur la boîte `villa@`.
