# Module 4 — Recherche intelligente

## Objectif
Chercher en langage naturel au lieu de manier des filtres :
> "Les formations OPCA de mars."
> "Les formations où Jean est intervenu."
> "Toutes les sessions avec moins de 8 stagiaires."

## Ce qu'on sait déjà (bonne nouvelle : le moteur de recherche existe déjà côté serveur)
`data-beans.xml` montre qu'un grand nombre de DAOs déclarent déjà un
`filterOption` avec une liste de **`freeField`** — les colonnes qui
participent à une recherche libre multi-champs. Exemples confirmés :

- `companyDao` → `freeField: ['company.name','company.email','company.address','company.address2','company.city','company.phone','company.fax']`
- `roomDao` → `freeField: ['code','name','address','address2','postal_code','city']`
- `patternDao` (base de `conventionDao`) → `freeField: ['convention.name','actor.lastname','actor.firstname','company.name','convention.code','convention.proposal_code']`
- `diplomaDao`, `countryDao`, etc. ont le même mécanisme

C'est exactement la fonction du bouton **"Rechercher"** vu dans la toolbar
de l'écran Dossiers dans les captures d'écran. Le filtrage classique par
propriété (`activated=1`, `status=CURRENT`) qu'on utilise déjà dans
`live-reports.js` est un axe de recherche complémentaire à celui-ci — la
recherche libre (`freeField`) en est un autre, déjà câblé côté serveur.

## Ce qu'il reste à découvrir
Le nom exact du paramètre HTTP qui déclenche la recherche `freeField`
(probablement une convention simple comme `query=` ou `freeField=`, à
capturer en cliquant sur "Rechercher" et en tapant un terme dans l'appli) :

```
1. Ouvrir un écran avec bouton "Rechercher" (ex: Dossiers)
2. Taper un terme, valider
3. DevTools → Réseau → repérer l'appel /wa/{entité}/list
4. Regarder les Query String Parameters pour trouver celui qui porte le terme
```

## Architecture proposée
Deux axes de recherche à combiner, tous deux pilotables par le LLM :
1. **Filtre structuré** — le LLM extrait des critères précis ("mars" →
   `startDate` entre deux bornes, "OPCA" → `financer=1` sur `customer`) et
   les passe en query params, comme `pct_nouveaux_clients`/`devis_a_relancer`
   le font déjà dans `reports.py`.
2. **Recherche libre** — pour les critères moins structurés ("les
   formations où Jean est intervenu"), le LLM identifie l'entité cible et
   passe le terme via le paramètre `freeField` une fois confirmé.

Le LLM n'a pas besoin de deviner : une fois qu'on a la liste des colonnes
`freeField` par entité (déjà visible dans `data-beans.xml`), on peut lui
fournir cette liste pour qu'il sache quels termes sont cherchables où.

## Priorité / complexité
Haute valeur, **complexité très faible** — c'est le module le plus proche
d'être terminé : une seule capture réseau manque avant de pouvoir
implémenter la recherche libre de bout en bout.
