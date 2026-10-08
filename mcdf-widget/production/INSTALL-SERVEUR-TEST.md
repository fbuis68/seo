# Installation sur le serveur de test — test.moncentredeformation.fr

Ce document décrit le déploiement du widget IA sur l'environnement de
**test** de MCDF, avant toute mise en production. Il complète
`INTEGRATION.md` (qui reste la référence technique pour le développeur)
avec une procédure pas-à-pas et une checklist de validation propres à cet
environnement.

## 1. Ce qui est livré

| Fichier | Rôle |
|---|---|
| `widget-ia.html` | **Le livrable** — page autonome à déployer sur le serveur. Lecture seule, aucune dépendance externe. |
| `INTEGRATION.md` | Instructions techniques pour le développeur (emplacement, intégration ExtJS, paramètre `entityId`). |
| `mock_server.py` / `mock_server.js` | Serveurs de test **locaux** (données fictives) pour valider le widget avant même de le déployer sur `test.moncentredeformation.fr` — voir §2. |
| `INSTALL-SERVEUR-TEST.md` | Ce document. |

## 2. Avant de déployer : valider en local (recommandé)

Pas indispensable, mais ça permet de confirmer que le widget lui-même
fonctionne correctement avant de toucher au serveur de test — élimine une
source d'incertitude si quelque chose ne va pas après déploiement.

```
python3 mock_server.py        # ou : node mock_server.js
```
puis ouvrir `http://localhost:8000/widget-ia.html?entityId=E00000361` —
si les 7 sections s'affichent sans bandeau d'erreur, le widget est prêt à
être déployé. (Détail complet dans les échanges précédents / l'historique
du projet.)

## 3. Déploiement sur test.moncentredeformation.fr

### 3.1 Prérequis
- Un accès au serveur d'application qui héberge `test.moncentredeformation.fr`
  (ou la coordination avec la personne/l'équipe qui gère les déploiements
  de `WebContent/` sur cet environnement).
- Le widget étant une page statique, **aucune recompilation Java n'est
  nécessaire** — c'est un simple fichier à copier.

### 3.2 Copier le fichier
Déposer `widget-ia.html` dans `WebContent/` de l'application déployée sur
`test.moncentredeformation.fr`, selon votre méthode de déploiement
habituelle (copie directe, pipeline de build existant, etc.). Emplacement
suggéré :
```
WebContent/widget-ia.html
```
Comme pour tout fichier statique de `WebContent/`, il sera immédiatement
accessible à :
```
https://test.moncentredeformation.fr/widget-ia.html
```
sans redémarrage du serveur applicatif (sauf si votre configuration met
en cache agressivement les fichiers statiques).

### 3.3 Pourquoi aucune configuration de domaine n'est nécessaire
Le widget appelle l'API avec des **chemins relatifs** (`/wa/{entité}/list`,
jamais une URL complète codée en dur). Concrètement, il s'adapte
automatiquement à l'environnement qui le sert :
- déployé sur `test.moncentredeformation.fr` → il interroge l'API de test
- déployé plus tard sur `portal.moncentredeformation.fr` (production) →
  il interrogera l'API de production, sans qu'aucune ligne du fichier
  n'ait besoin d'être modifiée

### 3.4 Intégration dans le menu de l'application
Voir `INTEGRATION.md` §3 pour l'extrait de code ExtJS (nouvel onglet avec
iframe). Sur l'environnement de test, faire pointer l'iframe vers :
```
https://test.moncentredeformation.fr/widget-ia.html?entityId=<entité de test>
```

## 4. Checklist de validation post-déploiement

À faire une fois le fichier déposé et le lien/onglet ajouté :

- [ ] Se connecter normalement à `test.moncentredeformation.fr`
- [ ] Ouvrir le widget (onglet/lien ajouté, ou directement l'URL avec `?entityId=...`)
- [ ] Le bandeau de statut en haut à droite affiche **"Entité ... · lecture seule"** (pas "Non connecté")
- [ ] Les 4 cases KPI affichent des valeurs (pas de "—")
- [ ] Le tableau **"Comparaison annuelle"** affiche 4 lignes
- [ ] **"Nouveaux clients par mois"** et **"30 derniers stagiaires"** sont remplis avec des données reconnaissables (noms/dates cohérents avec ce qui existe sur l'environnement de test)
- [ ] **Aucun appel d'écriture** n'a lieu — vérifiable dans DevTools → Réseau : uniquement des `GET /wa/.../list`, jamais de `POST`/`PUT` déclenché par le widget
- [ ] La page reste utilisable si on change d'entité test (`?entityId=...` différent)

## 5. Sécurité / portée (rappel)

- **Lecture seule** — le widget n'appelle que `GET /wa/{entité}/list`, jamais
  de création/modification.
- **Même origine** — aucune donnée ne sort de `test.moncentredeformation.fr` ;
  pas de service tiers, pas de télémétrie.
- **Pas de nouvelle authentification** — il réutilise le cookie de session
  déjà actif ; il n'introduit aucun compte, jeton ou mot de passe
  supplémentaire.
- **Retrait sans risque** — supprimer `widget-ia.html` et le lien de menu
  suffit à tout retirer ; aucune donnée n'a été modifiée, aucune migration
  à annuler.

## 6. Ce qui n'est pas couvert par cette version

Rappel (détaillé dans `ARCHITECTURE.md` et `modules/*/NOTES.md`) : actions
d'écriture, génération de documents, recherche libre et assistant Qualiopi
sont les prochains axes, pas encore dans ce livrable.
