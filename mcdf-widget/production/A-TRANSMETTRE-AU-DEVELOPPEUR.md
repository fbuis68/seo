# Widget IA MCDF — à installer sur test.moncentredeformation.fr

## Fichier à déployer
`widget-ia.html` (joint à ce message) → copier dans `WebContent/` de
l'application déployée sur `test.moncentredeformation.fr`, **en
remplaçant toute version précédemment déposée**.

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

## URL finale à utiliser
```
https://test.moncentredeformation.fr/widget-ia.html?entityId=E00000xxx
```
Remplacer `E00000xxx` par l'id trouvé à l'étape précédente — **sans
chevrons, sans crochets, sans espace autour**.

## Checklist de validation

- [ ] La page s'affiche avec des accents corrects ("Données", "écriture" — pas "DonnÃ©es", "Ã©criture")
- [ ] Le bandeau en haut à droite affiche **"Entité E00000xxx · lecture seule"**
- [ ] Les 4 cases en haut (Nouveaux clients, CA facturé, Sessions programmées, Devis à relancer) affichent des chiffres — pas uniquement des 0
- [ ] Si tout reste à 0 : essayer une autre entité de la liste obtenue à l'étape 3 (certaines entités de test peuvent être vides)
- [ ] Aucun bandeau rouge d'erreur en haut de page
- [ ] Aucune erreur dans la console (F12 → Console)

## En cas de problème persistant
Envoyer une capture d'écran de la page (URL visible dans la barre
d'adresse) **et** une capture de la console après avoir collé le script
de l'étape 3 — ça permet de diagnostiquer précisément sans aller-retours.
