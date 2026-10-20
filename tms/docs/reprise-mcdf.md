# Reprise MCDF → TMS

Source : base MariaDB `mcdf` (application Java). Cible : PostgreSQL TMS (migration `011_mcdf_alignment.sql`).

## Principes

- **Une table MCDF = une table TMS.** Chaque colonne MCDF a une colonne typée. À défaut, elle est conservée dans `legacy` (jsonb) sur la fiche. Aucune donnée n'est perdue.
- **`legacy_id` = ID MCDF** (ex. `A00124429`), unique par organisme.
  - Réimporter la même sauvegarde, ou une plus récente, n'ajoute que les nouveautés.
  - Les identifiants sont aussi enregistrés dans `external_identities` (`mcdf.<objet>`).
- **`custom_fields`** = `CUSTOMIZED_ADDITION_FIELD` (JSON MCDF, clés = libellés).
- **Organisme** : `ENTITY_ID` = un centre MCDF (table `entity`).
  - On choisit à l'import le ou les centres repris dans l'espace TMS.
  - Cocher aussi le centre parent si `PARENT_ENTITY_SESSION` est actif.
- **Jamais repris** : `PASSWORD` (SHA-256 non salé), `TOKEN`, `VITAL_CARD_NUMBER/KEY` (NIR), clés d'API (Qonto, B2BRouter, Iopole, Azure), `LICENSE`.
- **Dates** : MCDF stocke l'heure locale sans fuseau (`yyyy-MM-ddTHH:mm:ss`). Elle est convertie en UTC avec le fuseau de l'organisme (Europe/Paris).
- **Historique figé** :
  - factures émises sous la série `HIST-MCDF`, avec leur numéro d'origine, jamais réémises ;
  - aucun email ni relance déclenché.

## Obtenir la sauvegarde

```
mysqldump -u root -p --single-transaction --default-character-set=utf8mb4 mcdf | gzip > mcdf.sql.gz
```

Ensuite, dans Réglages → Reprise des données :

1. Choisir le logiciel « MCDF » et déposer `mcdf.sql.gz`.
2. Cocher le ou les organismes.
3. Lancer la simulation. Elle exécute tout dans une transaction annulée, avec les contraintes réelles.
4. Publier. Le lot peut être annulé tant que les données reprises n'ont pas été utilisées.

Le fichier est lu, jamais exécuté : seuls `CREATE TABLE` et `INSERT INTO` sont interprétés.

## Import en ligne de commande (gros volumes)

Sans limite de dépôt ni délai HTTP. Le lot apparaît ensuite dans Réglages → Reprise (rapport, annulation).

```
cd /opt/tms/src/tms
docker compose run --rm -v /data/mcdf-dump:/import:ro -e NODE_OPTIONS=--max-old-space-size=6144 api \
  node dist/scripts/mcdf-import.js --file /import/mcdf-donnees.sql.gz --email moi@centre.fr                       # liste des organismes
#   … --entities E1            → simulation (rien n'est écrit)
#   … --entities E1 --publish  → simulation puis publication
```

## Correspondance

### Référentiels

| MCDF | TMS |
|---|---|
| `absence`, `vat`, `payment_type`, `function`, `contract_type` (BPF), `diploma`, `diploma_type`, `level`, `discipline`, `nature`, `family`, `origin`, `course_type`, `activityarea`, `locality`, `logistic_type`, `cost`, `due`, `tariff`, `assessment`, `legal` | `reference_values` (`kind` = nom de table, `code`, `label`, `data`) |
| `country` | Code pays en texte sur les adresses |
| `tariff_training` | `tariff_prices` |

### Personnes et clients

| MCDF | TMS | Remarques |
|---|---|---|
| `actor` | `persons` + `person_roles` | Rôles : ATTENDEE ou CANDIDATE → `learner` (et `is_candidate`) ; TRAINER → `trainer` ; CONTACT → `contact` ; TUTOR → `tutor` ; ACCOUNT_MANAGER ou MANAGER → `staff`. COMPANY_ID → `employer_client_id`. Les références TUTOR_ID, ACCOUNT_MANAGER_ID et MANAGER_ID sont reprises. |
| `actor` (formateur) | `trainer_profiles` | HOURLY_RATE, NIGHT_RATE, BANK_HOLIDAY_RATE, SIRET, NDA, IBAN, CONTRACT_TYPE (PREST, CDI…), carte professionnelle |
| `appuser` | non repris | Comptes de connexion : invitation à recréer l'accès |
| `company` | `clients` (`kind=company`) | FINANCER → `is_funder`. Adresse → `billing_address`. Conditions de paiement → `payment_terms`. |
| `customer` | `clients` | COMPANY_ID → client entreprise ; ACTOR_ID → client particulier (`kind=person`). Tous les payeurs MCDF (`customer_id`, `OPCA_ID`, `PAYER_ID`, `ACCOUNT_ID`) pointent vers `customer.ID`. |
| `actor_company` | `client_contacts` | INVOICE_RECEIPT → `receives_invoices` |
| `actor_discipline`, `actor_diploma`, `skillful` | `person_qualifications` | |

### Catalogue, salles et sessions

| MCDF | TMS | Remarques |
|---|---|---|
| `training` (+ `training_entity`) | `programs` + `program_versions` | HOURS → `duration_minutes` ; PRICE et VAT_ID → `price_ht` et `vat_rate` |
| `room` | `resources` (`kind=room`) | |
| `session` | `training_sessions` | CODE → `reference` (suffixé si en double) ; NUMBER_MINI/MAXI → `min_participants`/`capacity`. Intra si un seul client sur ses conventions. |

### Conventions

| MCDF | TMS | Remarques |
|---|---|---|
| `convention` | `conventions` | Un seul enregistrement couvre devis, dossier et parcours, comme dans MCDF : IS_PROPOSAL, IS_CONVENTION, PATTERN. PROPOSAL_STATUS (O, L, W…) et CONVENTION_STATUS (CURRENT, CLOSED…) sont conservés tels quels. CONTACT_ID → `actor_company` → personne. |
| `convention_training` | `convention_lines` | Le bogue MCDF sur `ENTITY_ID` est corrigé : rattachement par la convention. |
| `convention_payer` | `convention_payers` | |
| `convention_contract_type` | `conventions.contract_type_ids` | |
| `timetable` | `convention_installments` | Échéancier, avec lien vers la ligne facturée |
| `actor_convention`, `commission` | `convention_staff` | |
| `convention_attendee` | `convention_attendees` | |
| `convention_attendee_session` | `enrollments` (`convention_id`, `objective`) | Sans affectation explicite, le stagiaire est inscrit à toutes les sessions des lignes de sa convention. |

### Planning et émargement

| MCDF | TMS | Remarques |
|---|---|---|
| `schedule` TYPE=CONF | `slots` | Statut : CANCELED → annulé ; FULFILLED, VALIDATED, TIMESHEET, INVOICED, PAST ou date passée → réalisé ; DRAFT → brouillon ; REQUEST → en attente ; sinon publié. PATTERN : non repris. |
| `schedule` TYPE=CSTR, ou SCHEDULE_ID renseigné | `availabilities` (indisponibilité) | Contrainte ou trajet |
| `schedule` TYPE=CLOS | `closures` | |
| `schedule.TRAINER_ID` + `actor_schedule` ACTOR=TRAINER | `slot_trainers` (`lead` / `co`) | |
| `schedule.ROOM_ID` + `schedule_room` | `slot_resources` | |
| `actor_schedule` ACTOR=ATTENDEE | `attendance` | MISSING → absent (0 min), sinon présent pour toute la durée du créneau. ABSENCE_ID et BILLABLE sont repris. |
| `actor_schedule` ACTOR=TRAINER | `trainer_attendance` | |
| `attendee_schedule` | `attendance` | Ancienne table, reprise si présente |
| `costs` | `session_costs` | |

### Facturation

| MCDF | TMS | Remarques |
|---|---|---|
| `invoice` STATUS=I | `invoices` émises (`HIST-MCDF`) | CODE = numéro d'origine. INVOICE_ID renseigné → avoir lié (`credited_invoice_id`). Les coordonnées figées PAYER_*, ACCOUNT_*, CONTACT_* et CONVENTION_* vont dans `*_snapshot`. |
| `invoice` STATUS=P | `invoices` brouillon | Proforma : jamais émise |
| `invoice_line` | `invoice_lines` | |
| `invoice_attendee` | `invoice_attendees` | |
| `payment` | `payments` | PRESENTATION_CODE/DATE → bordereau de remise |
| `payment_invoice` | `payment_allocations` | Lettrage |

### Pièces et tables non reprises

| MCDF | TMS | Remarques |
|---|---|---|
| `actor_document`, `company_document`, `convention_document`, `session_document`, `training_document` | `documents` + stockage | CONTENT au format data URL base64, ou DOCUMENT en blob |
| `task`, `question`, `tasks`, `comeback`, `evaluation` | non repris pour l'instant | Questionnaires |
| `message`, `message_template`, `template`, `rule`, `report` | non repris | Modèles et automatismes à reparamétrer |
| `device_facility`, `order_line`, `synchronize`, `mobile_sync`, `activity`, `grouping`, `status`, `profile_right_copy`, `sequencer`, `counter`, `tree` | non repris | Tables techniques ou obsolètes |

## Rejets possibles (visibles dans la simulation)

- Facture dont le payeur est introuvable, ou dont le numéro est en double.
- Règlement sans payeur, sans montant ou sans date.
- Créneau sans date ni heure exploitable.
- Les objets d'un autre organisme ou hors périmètre sont comptés comme « exclus ».
