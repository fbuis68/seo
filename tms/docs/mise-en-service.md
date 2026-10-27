# Mise en service (onboarding) — couverture du cahier des charges v1.0

## Livré : lot 1

### Assistant

| Exigence | Réalisation |
|---|---|
| ONB 01 | 3 parcours (« Je démarre », « Je reprends Excel », « Je migre un logiciel ») et questions d'accueil : activité, pays, devise, sociétés, outil précédent, volume, objectif. |
| ONB 02 | Assistant en 7 étapes (`/onboarding`) : Entreprise, Données, **Formation et planning**, Paramètres de facturation, Vérification, Première facture, Finalisation.<br>• sauvegarde automatique, avec contrôle de version entre appareils ;<br>• progression calculée sur les exigences satisfaites. |
| ONB 03 | Rôles « Responsable facturation » (`accountant` : prépare, confirme, émet) et « Chargé de reprise » (`importer` : reprise, sans droit d'émission). Permission dédiée `invoices.issue`. Le support garde son accès temporaire et tracé. |
| ONB 04 | Relances email à 24 h et 72 h d'inactivité :<br>• une seule par palier ;<br>• arrêtées dès « Prêt à facturer » ou à la clôture.<br>Bouton « Demander de l'aide » et aide « ? » sur chaque étape. |
| ONB 05 | Suivi des reprises : source, volumes reçus, importés, rejetés et exclus. États « À compléter », « En cours », « En erreur », « À valider », « Validé », « Différé ». Étapes différables. |

### Mise en route d'une formation (étape « Formation et planning »)

Diagnostic serveur `GET /api/v1/start-readiness?sessionId=` (sans paramètre : la session la plus proche). Création rapide dans l'étape : formation, formateur, salle, session (créée puis planifiée), séance publiée, inscription d'un apprenant.

| Domaine | Bloquant | Avertissement |
|---|---|---|
| Formation | Aucune formation au catalogue (intitulé, durée, modalité). | — |
| Formateur | Aucun formateur actif. | — |
| Lieu | Aucune salle ni site, si une formation est en présentiel ou mixte. | Formations 100 % distancielles : lien de visio exigé sur la séance. |
| Session | Pas de session ; dates absentes ; intra sans client ; session restée en brouillon. | — |
| Planning | Aucune séance ; séance incomplète ou en conflit (formateur, salle ou visio manquants, chevauchements, indisponibilité, fermeture, horaires, compétences, matériel, capacité de la salle, VGP échue) ; séance non publiée (invisible, émargement fermé). | Heures planifiées inférieures à la durée prévue. |
| Apprenants | Aucun apprenant ; aucune inscription confirmée ; capacité dépassée. | Minimum de participants non atteint. |
| Offre | Sessions actives (Free : 3) ou sessions du mois (Solo 10, Équipe 20, Centre 50) atteintes : changer d'offre. | Quota d'apprenants de l'année. |
| Documents | — | Convocations non générées ; convention (intra) non générée. |

### Reprise (module existant)

| Exigence | Réalisation |
|---|---|
| IMP 01 | Fichiers CSV (UTF-8 ou Windows-1252) et XLSX. Macros et formules jamais exécutées. Sauvegarde MCDF. Modèle Excel « Clients / Apprenants » téléchargeable ; assistant d'import intégré à l'étape « Données » (dépôt, association des colonnes modifiable avec exemples, simulation, publication, rapport, annulation). |
| IMP 06 | Simulation obligatoire. |
| IMP 07 | Doublons repérés par identifiant source, puis par clé métier. Résultat ligne à ligne en tableau (simulation et publication, `GET /api/v1/imports/:id/results`) : onglets Erreurs / Alertes / Importées / Toutes, chaque erreur référencée par fichier ou feuille, n° de ligne du tableur, colonne (lettre et en-tête), message et correction attendue. Même contenu en CSV téléchargeable. |
| IMP 08 | Idempotence et annulation du lot. |
| IMP 09 | Rapprochement : lignes reçues = créées + mises à jour + inchangées + rejetées + exclues ; totaux financiers vérifiés. |

### Facturation

| Exigence | Réalisation |
|---|---|
| FAC 01, 02, 05 | Profil de facturation versionné : régime de TVA (jamais déduit du pays), mention d'exonération, délai et moyens de paiement, pénalités, indemnité de 40 €, IBAN vérifié par sa clé de contrôle. Confirmation obligatoire ; modifier un champ critique annule la confirmation. Prix HT, arrondi par ligne. |
| FAC 03 | Numérotation et bascule : préfixe, prochain numéro, dernier numéro de l'ancien outil, date de bascule. Contrôle de chevauchement et de collision avec l'historique. Préfixe figé après la première émission. Numéro attribué à l'émission, sous verrou. |
| FAC 06 | Diagnostic exécuté par le serveur (`GET /api/v1/billing-readiness`), puis à nouveau juste avant chaque émission. États « préparer », « émettre », « transmettre ». Points bloquants : émetteur, profil, numérotation, droits, adresse du client, lignes, TVA cohérente avec le régime, montants, double facturation, date de bascule. Simples avertissements : logo absent, reprise en cours. |
| FAC 07 | Brouillon et aperçu PDF sans numéro (« APERÇU »). Émission avec rappel du montant et du destinataire. Rejouer l'émission renvoie la même facture. |
| FAC 09 | Facture émise immuable, corrigée par avoir. Jalons « Première valeur obtenue » (premier brouillon) et « Première facture émise ». |

### Recette

- Tests `test/onboarding.e2e.test.ts` :
  - REC 01 : parcours complet ;
  - REC 03 : émission protégée ;
  - ONB 04 : relances.
- Tests `test/start-readiness.e2e.test.ts` : du compte vide à « prêt à démarrer », et cas 100 % distanciel.
- Les tests existants couvrent REC 02 (reprise) et REC 04 (isolation, historique non réémis).

## Non livré

- **Lot 2** :
  - connecteurs API ;
  - reprise documentaire étendue ;
  - export différentiel ;
  - console support enrichie ;
  - traitement de la reprise en tâche de fond avec barre de progression : aujourd'hui, la reprise est synchrone pour les fichiers, et la commande serveur sert pour les gros volumes ;
  - modèles téléchargeables pour les autres objets (formations, factures, règlements).
- **Lot 3** : suggestions d'IA pour la correspondance des colonnes, automatisations.
- **FAC 08** : états de transmission détaillés (« Transmission en cours », « Échec », nouvelle tentative) pour l'email. La facture électronique dispose déjà de ses statuts.
- **Indicateurs (section « Mesure du succès »)** : les horodatages des jalons sont stockés (`onboarding_sessions`), mais le tableau de bord éditeur n'est pas encore fait.

## Import rapide clients / apprenants (parcours repris de Serv-Izy)

- Où : boutons « Importer (Excel / CSV) » des écrans Clients et Apprenants & formateurs, et Mise en service › Données (« 1. Importer les clients », puis « 2. Importer les apprenants »).
- Parcours :
  1. déposer un fichier ;
  2. vérifier la correspondance colonne par colonne (en-tête, exemple, champ proposé, modifiable) ;
  3. l'aperçu se recalcule à chaque changement, avec un statut par ligne (OK, à vérifier, erreur, doublon) et la liste des lignes à vérifier ;
  4. importer en un clic, depuis une barre qui reste visible.
- Reconnaissance des colonnes :
  - nom complet découpé (« Mme MARTIN Jeanne ») ;
  - colonnes d'adresse concaténées ;
  - zéros initiaux restaurés (téléphone, code postal) ;
  - civilités normalisées.
- Doublons :
  - clients : même SIRET ou même nom ;
  - personnes : même email, ou même nom avec la même date de naissance ;
  - identifiant déjà importé ;
  - ligne en double dans le fichier.
  - Un homonyme est seulement signalé.
- Publication par un lot de reprise classique : journal, rapport ligne à ligne et annulation (« Annuler l'import ») restent disponibles.
- API : `POST /api/v1/imports/quick/{client|person}/{preview|commit}`. Le corps contient le fichier ; en-têtes `X-Filename` et `X-Mapping` (JSON, une entrée par colonne).
