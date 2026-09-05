# Widget IA MCDF — à installer sur test.moncentredeformation.fr

## Emplacement confirmé sur le serveur
`/var/lib/tomcat/webapps/ROOT/` — c'est là que vont tous les fichiers
listés ci-dessous, à la racine (même niveau que `ext-all-debug.js`
dans son sous-dossier `scripts/premium/ext/`).

## Fichiers à déployer
- `widget-ia.html` — module Génération de rapports
- `widget-conversationnel.html` — module IA Conversationnelle (v1)
- `widget-qualiopi.html` — module Assistant Qualiopi (v1 découverte)
- `launcher-embed.js` — bouton flottant, une seule ligne à intégrer
  (voir `INSTALL-LAUNCHER.md`)

Tous à copier dans `/var/lib/tomcat/webapps/ROOT/`, **en remplaçant
toute version précédemment déposée**.

## Commande de mise à jour (à chaque nouvelle version)
Depuis une session PuTTY connectée au serveur (`su -` puis mot de passe
root si besoin) :
```bash
cd /var/lib/tomcat/webapps/ROOT && curl -o widget-ia.html https://raw.githubusercontent.com/fbuis68/seo/claude/mcdf-ai-widget-xxnxub/mcdf-widget/production/widget-ia.html && head -1 widget-ia.html
```
Remplacer `widget-ia.html` par le nom du fichier à mettre à jour (même
commande, juste changer le nom aux 3 endroits). Le `head -1` doit
afficher `<meta charset="utf-8">` pour les fichiers `.html`, ou le
début du commentaire `/**` pour `launcher-embed.js`.
Aucun redémarrage nécessaire (fichiers statiques) — juste `Ctrl+Maj+R`
côté navigateur pour vider le cache avant de tester.

## ⚠️ 3 points de vigilance (déjà rencontrés lors des premiers tests)

### 1. Vérifier que c'est bien la dernière version, avant de déployer
Ouvrir `widget-ia.html` dans un éditeur de texte. La **toute première
ligne** du fichier doit être :
```
<meta charset="utf-8">
```
Si ce n'est pas le cas, ce n'est pas la bonne version — la retélécharger
depuis :
https://github.com/fbuis68/seo/raw/claude/mcdf-ai-widget-xxnxub/mcdf-widget/production/widget-ia.html

*(Sans cette ligne, les accents s'affichent cassés : "DonnÃ©es" au lieu
de "Données".)*

### 2. Vider le cache après déploiement
Une fois le fichier copié sur le serveur, faire un **rechargement forcé**
côté navigateur avant de tester : `Ctrl + Maj + R` (Windows) ou
`Cmd + Maj + R` (Mac). Sans ça, le navigateur peut continuer d'afficher
l'ancienne version depuis son cache.

### 3. Le paramètre `entityId` doit venir de CE serveur précis
`test.moncentredeformation.fr` a sa **propre base de données**,
différente de l'environnement de production
(`portal.moncentredeformation.fr`). Un identifiant d'entité trouvé sur un
serveur ne sera pas forcément valide sur l'autre.

Pour trouver un identifiant d'entité valide **sur ce serveur de test** :
1. Se connecter à `test.moncentredeformation.fr`
2. Ouvrir la console du navigateur (touche **F12** → onglet **Console**)
3. Coller ce code et appuyer sur Entrée :
   ```js
   fetch(`/wa/entity/list?nopaging=1&_dc=${Date.now()}`)
     .then(r => r.json())
     .then(d => console.table(d.root.map(e => ({ id: e.id, name: e.name }))));
   ```
4. Une liste s'affiche avec des `id` du type `E00000xxx` — en choisir un
   (idéalement celui utilisé habituellement pour les tests)

## URLs finales à utiliser
```
https://test.moncentredeformation.fr/widget-ia.html?entityId=E00000xxx
https://test.moncentredeformation.fr/widget-conversationnel.html?entityId=E00000xxx
https://test.moncentredeformation.fr/widget-qualiopi.html?entityId=E00000xxx
```
Remplacer `E00000xxx` par l'id trouvé à l'étape précédente — **sans
chevrons, sans crochets, sans espace autour**. Le lanceur flottant
(`launcher-embed.js`, déjà installé) pointe automatiquement vers les
3 premiers modules une fois `window.MCDF_CURRENT_ENTITY_ID` renseigné.

## Checklist de validation

- [ ] `widget-ia.html` : accents corrects, bandeau **"Entité E00000xxx · lecture seule"**, les 4 cases en haut affichent des chiffres non nuls
- [ ] `widget-ia.html` : le sélecteur "Jusqu'à" au-dessus du tableau de comparaison change bien les chiffres quand on choisit un autre mois
- [ ] `widget-conversationnel.html` : cliquer une suggestion (ex. "Quels devis relancer ?") affiche une vraie réponse chiffrée, pas le message "je ne sais pas encore répondre"
- [ ] `widget-qualiopi.html` : au moins une des 3 entités testées passe au badge "OK" (sinon, c'est normal pour l'instant — coller le résultat de `browser/live-qualiopi-check.js` dans la conversation pour qu'on ajuste)
- [ ] Si tout reste à 0 : essayer une autre entité de la liste obtenue à l'étape 3 (certaines entités de test peuvent être vides)
- [ ] Aucun bandeau rouge d'erreur en haut de page
- [ ] Aucune erreur dans la console (F12 → Console)

## En cas de problème persistant
Envoyer une capture d'écran de la page (URL visible dans la barre
d'adresse) **et** une capture de la console après avoir collé le script
de l'étape 3 — ça permet de diagnostiquer précisément sans aller-retours.
