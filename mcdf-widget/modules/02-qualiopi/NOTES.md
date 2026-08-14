# Module 2 — Assistant Qualiopi

## Objectif
Réduire le stress des audits Qualiopi :
- vérifier que chaque indicateur possède ses preuves
- signaler les documents manquants
- préparer un audit blanc / une check-list personnalisée
- répondre à des questions du type "Montre-moi tout ce qui manque pour le
  critère 6."

## Ce qu'on sait déjà (bonne nouvelle : ce n'est pas à construire de zéro)
En explorant `controller-beans.xml` et `data-beans.xml`, Qualiopi est déjà un
**module de première classe** dans MCDF, pas quelque chose à ajouter :

- DAOs dédiés confirmés dans le code source :
  - `sessionQualiopiDao` (parent `sessionSelectDao`, interceptor `SessionQualiopiSelect`)
  - `conventionExportQualiopiDao` (parent `conventionExportDao`, interceptor `ConventionQualiopiSelect`)
  - `fullConventionQualiopiDao` (parent `fullConventionDao`, même interceptor)
- Controllers correspondants : `sessionQualiopiController`, `conventionExportQualiopiController`,
  `fullConventionQualiopiController`
- Ces noms apparaissent dans la liste des ~300 entités enregistrées par
  `chiefOrchester` — donc, par le même pattern que toutes les autres entités
  confirmées (`convention`, `session`, `actor`...), ils sont probablement
  déjà accessibles via `/wa/sessionQualiopi/list`, `/wa/conventionExportQualiopi/list`,
  `/wa/fullConventionQualiopi/list`.

## Ce qu'il reste à tester (une seule capture suffit probablement)
Dans la console, sur une entité DEMO :

```js
for (const e of ['sessionQualiopi', 'conventionExportQualiopi', 'fullConventionQualiopi']) {
  fetch(`/wa/${e}/list?nopaging=1&limit=3&_dc=${Date.now()}`)
    .then(r => r.json())
    .then(d => console.log(`${e} →`, d.success ? Object.keys(d.root[0]||{}).sort() : d));
}
```

Les champs retournés diront exactement quels indicateurs/preuves Qualiopi
sont déjà structurés dans le système (probablement des colonnes booléennes
ou des dates de conformité par critère).

## Architecture proposée
1. Une fois les champs confirmés, mapper les critères Qualiopi (les 32
   indicateurs du référentiel) aux champs disponibles sur `sessionQualiopi`
   / `conventionExportQualiopi`.
2. Une fonction de restitution (miroir du pattern `reports.py`) : pour un
   critère donné, lister les sessions/conventions dont les preuves
   attendues sont manquantes.
3. Le copilote (module 1) expose ça comme une question en langage naturel
   une fois la couche conversationnelle en place.

## Priorité / complexité
Haute valeur, **complexité probablement faible** — contrairement au module 1,
il n'y a a priori pas d'écriture à faire ici, juste de la lecture structurée
sur des entités qui existent déjà.
