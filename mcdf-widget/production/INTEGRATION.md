# Intégration du widget IA dans MCDF — guide développeur

## Ce que c'est
`widget-ia.html` est une page **unique, autonome** (HTML + CSS + JS, aucune
dépendance externe, aucun build) qui affiche des restitutions en direct
(nouveaux clients, stagiaires inscrits, CA, devis à relancer, comparaison
N/N-1, top formateurs) à partir de l'API MCDF existante.

**Lecture seule.** Ce widget n'effectue aucun appel de création ou de
modification — uniquement des `GET /wa/{entité}/list`, exactement comme le
reste de l'application MCDF.

## Pourquoi c'est simple à intégrer
Le widget s'appuie sur le **cookie de session déjà actif** dans le
navigateur — tant qu'il est servi depuis le même nom de domaine que MCDF
(même origine), il hérite automatiquement de l'authentification. Aucun
nouveau système d'auth, aucune clé d'API à gérer.

## Étapes d'intégration

### 1. Déposer le fichier
Copier `widget-ia.html` quelque part dans `WebContent/`, par exemple :
```
WebContent/widget-ia.html
```
(N'importe quel emplacement fonctionne tant qu'il est servi par la même
webapp — c'est juste une page statique de plus.)

### 2. Lui donner l'entité courante
Le widget filtre ses données via le paramètre d'URL `entityId`. Il faut le
passer depuis le contexte applicatif qui connaît déjà l'entité
actuellement sélectionnée (le sélecteur en haut à droite de l'appli) :

```
/widget-ia.html?entityId=E00000361
```

Sans ce paramètre, le widget affiche les données de **toutes les entités**
auxquelles le compte connecté a accès (visible et signalé par un bandeau
d'avertissement dans le widget) — pratique pour tester, à éviter en usage
normal.

### 3. L'insérer dans l'appli (deux options)

**Option A — nouvel onglet ExtJS avec iframe (recommandé)**
Ajouter un panneau contenant une iframe pointant vers le widget, avec
l'entité courante injectée dynamiquement :

```js
Ext.create('Ext.panel.Panel', {
  title: 'Copilote IA',
  html: '<iframe src="/widget-ia.html?entityId=' + currentEntityId +
        '" style="width:100%;height:100%;border:0"></iframe>',
  // ... l'intégrer comme les autres onglets du menu principal
});
```
(`currentEntityId` = la variable qui contient déjà l'entité sélectionnée
côté client — celle qui alimente le sélecteur d'entité dans le header.)

**Option B — lien simple / nouvelle fenêtre**
Un simple lien `<a>` ou bouton toolbar ouvrant `/widget-ia.html?entityId=...`
dans un nouvel onglet. Moins intégré visuellement, mais zéro travail
ExtJS.

### 4. Vérifier
Ouvrir le widget alors que vous êtes connecté à MCDF dans le même
navigateur — les données doivent apparaître en quelques secondes. Si un
bandeau rouge "Session MCDF non détectée" apparaît, c'est que le widget
n'est pas servi depuis la même origine que l'appli (vérifier le domaine).

## Ce qui n'est PAS encore dans cette version
- **Actions d'écriture** (créer une session, inscrire un stagiaire...) —
  nécessite de découvrir les endpoints de création/modification, non
  encore confirmés. Voir `modules/01-conversationnel/NOTES.md`.
- **Vrai taux de remplissage par session** — le lien session↔inscrits
  n'est pas encore confirmé côté API (probablement via une entité
  `conventionTraining` non explorée). Le panneau "Sessions programmées"
  montre donc un volume (nombre de sessions avec capacité déclarée), pas
  un taux réel — c'est indiqué dans le pied de page du widget.
- **Génération de documents et recherche libre** — voir
  `modules/03-documents/NOTES.md` et `modules/04-recherche/NOTES.md`
  pour l'état d'avancement de ces deux axes.

## Sécurité / portée
- Aucune donnée n'est envoyée en dehors de MCDF — tous les appels restent
  sur le même domaine (`/wa/...`), comme le reste de l'application.
- Le widget respecte les droits du compte connecté (mêmes restrictions
  serveur que le reste de l'appli) — il n'élève aucun privilège.
- Pas de stockage local, pas de cookie propre, pas de tracking.
