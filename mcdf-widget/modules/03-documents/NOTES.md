# Module 3b — Génération de documents

(La partie "génération de rapports" de ce thème est **déjà livrée** —
voir `schema.sql`/`seed.py`/`reports.py`/`dashboard.html` à la racine et
`browser/live-reports.js` pour la version sur données réelles. Ce fichier
couvre uniquement la partie "documents" : conventions, convocations,
attestations, comptes rendus.)

## Objectif
Générer automatiquement les documents habituellement rédigés à la main :
programme de formation, convention, convocation, attestation
personnalisée, compte rendu.

## Ce qu'on sait déjà (bonne nouvelle : infrastructure déjà en place)
Découvert dans `WebContent/WEB-INF/lib/` (liste des .jar) et `data-beans.xml` :

- **FreeMarker** (`freemarker-2.3.20.jar`) — moteur de templates
- **XDocReport** (`fr.opensagres.xdocreport.*`) — génération de documents
  Office (Word/PDF) depuis des templates, avec conversion `poi.xwpf.converter`
- **docx4j**, **iText/iTextPDF**, **Aspose PDF**, **Apache FOP** — manipulation
  et rendu PDF
- Des DAOs de documents confirmés : `actorDocumentDao`, `companyDocumentDao`,
  `sessionDocumentDao`, `conventionDocumentDao`, `trainingDocumentDao`,
  `messageDocumentDao` — chacun avec des variantes `...Set`/`...Basic`
- Un système de **templates** : `templateDao`, `templateOnEntityDao`
  (bean `TemplateController`), donc les modèles de documents sont déjà
  administrables dans MCDF, pas à réinventer.
- Un service explicite : `com.serigest.premium.service.business.DocumentService`
  (vu dans `allDocumentController`), qui centralise `actorDocumentDao`,
  `conventionDocumentDao`, `companyDocumentDao`, `sessionDocumentDao`.

**Conclusion : MCDF sait déjà générer des documents depuis des templates.**
Le widget IA n'a pas besoin de reconstruire un pipeline de génération — il
doit identifier le bon template et déclencher la génération existante.

## Ce qu'il reste à découvrir
Aucune requête de génération de document n'a encore été capturée. Il faut :
1. Dans l'appli MCDF, ouvrir un Dossier → onglet "Document attaché", cliquer
   sur un bouton de type "Générer"/"Imprimer" (vu dans la toolbar : icône
   "Imprim...")
2. Capturer la requête réseau (probablement `POST` avec l'id du template et
   l'id de l'enregistrement cible) et la réponse (fichier binaire ? lien de
   téléchargement ? id de document créé dans `conventionDocumentDao` ?)

**Envoi / signature électronique** (demandé le 22/08/2026) : même situation,
aucun endpoint capturé. Procédure de capture détaillée dans
`CAPTURE-ENVOI-SIGNATURE.md` — à faire sur un dossier de test, pas un vrai
client, car c'est une action à effet réel (contrairement à tout le reste du
widget qui est en lecture seule). Une fois la requête capturée, le widget
pourra proposer un déclenchement réel, avec confirmation explicite avant
toute écriture.

## Architecture proposée
1. Le copilote identifie l'intention ("prépare la convention pour la
   session X") et résout l'entité cible (`convention.id`).
2. Il liste les templates disponibles via `templateDao`/`templateOnEntityDao`
   (à tester avec le même pattern `list_entity('template', ...)`).
3. Il déclenche l'endpoint de génération une fois confirmé, avec l'id du
   template et l'id de l'enregistrement.

## Priorité / complexité
Valeur moyenne à haute, complexité faible une fois l'endpoint de génération
identifié — c'est la même situation que Qualiopi : l'essentiel existe déjà
côté serveur.
