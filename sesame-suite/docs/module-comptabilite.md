# Module Comptabilité — récupération, extraction et pré-comptabilisation des factures

Référence technique du module (panneau **Comptabilité**, `/crm`, portée
`?scope=crm` réservée aux comptes Sesame). Implémente la chaîne achat
complète décrite dans le cahier des charges : dépôt d'un document →
extraction native PDF → classification → extraction structurée →
rapprochement fournisseur → proposition de compte → contrôles de
cohérence → écriture comptable brouillon → validation → numérotation
définitive.

## Périmètre de cette phase (Phase 1)

**Implémenté** :
- Modèle de données complet (fournisseurs, clients, documents, factures,
  lignes, TVA multi-taux, plan comptable, journaux, écritures, règles,
  doublons, journal d'audit) — `entityId` nullable partout (`null` = portée
  CRM/Sesame, sinon portée par établissement), même convention que
  `AutomationRule`/`Questionnaire`/`MessageTemplate`.
- Ingestion de documents (upload manuel/API), hash SHA-256, déduplication.
- Extraction du texte natif des PDF (`pdf-parse`) — **pas d'OCR image** :
  l'interface `OcrProvider` est prête (Azure Document Intelligence/Google
  Document AI/AWS Textract), mais aucun fournisseur n'est branché (aucun
  compte disponible dans cet environnement).
- Classification du type de document (facture/avoir/acompte/reçu/relevé).
- Extraction structurée **déterministe** (regex/heuristiques, jamais un
  appel à un modèle de langage) — n° facture, dates, SIRET/SIREN/TVA,
  IBAN/BIC, montants HT/TVA/TTC, ventilation multi-taux. Un champ non
  trouvé avec une confiance suffisante reste à `null` — jamais deviné.
- Contrôles de cohérence (HT+TVA=TTC, échéance ≥ date facture, clés de
  contrôle SIREN/SIRET/TVA/IBAN, changement d'IBAN fournisseur).
- Rapprochement fournisseur (SIRET > TVA > SIREN > IBAN > nom normalisé) +
  création automatique si un identifiant fort est présent.
- Moteur de proposition de compte (règle explicite > compte par défaut
  fournisseur > règle mot-clé > historique) + apprentissage à chaque
  correction utilisateur.
- Génération d'écriture DRAFT à la validation d'une facture, numérotation
  définitive atomique (jamais réutilisée) à la validation de l'écriture,
  extourne pour toute correction post-validation.
- Journal d'audit sur chaque action sensible.
- Panneau CRM (tuiles de synthèse, inbox de validation, fiches
  fournisseurs/plan comptable/écritures/règles).
- Import automatique par email (16/09/2026) : une boîte dédiée (ex.
  `administration@sesame-technology.com`), surveillée via le même mécanisme
  webhook Microsoft Graph que l'import de tickets support — chaque pièce
  jointe facture (PDF/JPEG/PNG/TIFF/XML) reçue devient une facture d'achat
  automatiquement (`source: "email"`), même pipeline que le dépôt manuel.

**Non implémenté dans cette phase** (schéma prêt mais pas de logique, ou
volontairement hors périmètre) :
- OCR image (PDF scanné, JPEG/PNG/TIFF) — statut `CHECK_REQUIRED`.
- Rapprochement et génération d'écriture côté **vente** (`AccCustomer`
  existe, aucune logique de rapprochement/proposition n'est branchée).
- Rapprochement bancaire (relevés, lettrage).
- Verrouillage de période comptable (clôture mensuelle/annuelle).
- Export FEC, connecteurs Sage/Cegid/QuickBooks, réception Drive/SFTP
  automatique (email est en revanche implémenté, cf. ci-dessus).
- Antivirus sur les documents déposés (aucun moteur AV disponible).

## Fichiers

| Fichier | Rôle |
|---|---|
| `prisma/schema.prisma` (modèles `Acc*`) | Modèle de données (§48) |
| `src/lib/accDocument.ts` | Ingestion, hash, déduplication |
| `src/lib/accOcr.ts` | Interface `OcrProvider` + texte natif PDF |
| `src/lib/accClassification.ts` | Type de document |
| `src/lib/accExtraction.ts` | Extraction structurée déterministe |
| `src/lib/accChecks.ts` | Contrôles de cohérence + validateurs SIREN/SIRET/TVA/IBAN |
| `src/lib/accSupplierMatching.ts` | Rapprochement/création fournisseur |
| `src/lib/accSeed.ts` | Plan comptable PCG courant + journaux standards |
| `src/lib/accRulesEngine.ts` | Proposition de compte + apprentissage |
| `src/lib/accEntryService.ts` | Génération/validation/extourne d'écriture |
| `src/lib/accPipeline.ts` | Orchestration document → facture |
| `src/lib/accAudit.ts` | Journal d'audit |
| `src/routes/accounting.ts` | Routes REST (`/wa/acc/...`) |
| `public/crm.html` (panneau "Comptabilité") | Interface |

## API (`/wa/acc/...`, Bearer admin requis, `?scope=crm` pour la portée Sesame)

### Documents

- `POST /acc/documents/upload` — `{filename, mimeType, base64, direction: "purchase"|"sale", source?}` → `{invoice, isDuplicateDocument}`. Lance tout le pipeline (extraction → classification → rapprochement → proposition de compte → contrôles).

### Factures

- `GET /acc/invoices?status=&direction=&supplierId=&q=&limit=&offset=` — liste paginée.
- `GET /acc/invoices/:id` — détail complet (document, fournisseur, lignes, TVA, écriture).
- `PUT /acc/invoices/:id` — correction manuelle des champs extraits (refusé si déjà `VALIDATED`/`ACCOUNTED`).
- `PATCH /acc/invoices/:id/account` — `{accountId}` : impose le compte comptable, alimente le moteur de règles (apprentissage).
- `POST /acc/invoices/:id/validate` — confirmation humaine : génère l'écriture DRAFT si absente (idempotent), passe la facture en `VALIDATED`. Une alerte `BLOCKING` n'empêche jamais cette validation explicite.
- `POST /acc/invoices/:id/reject` — passe la facture en `REJECTED`.

### Fournisseurs

- `GET /acc/suppliers?q=`, `POST /acc/suppliers`, `PUT /acc/suppliers/:id`.

### Plan comptable / journaux

- `GET /acc/accounts?type=&active=`, `POST /acc/accounts`, `PUT /acc/accounts/:id`.
- `POST /acc/seed` — initialise le plan comptable PCG courant + journaux ACH/VEN/BQ/OD (idempotent).
- `GET /acc/journals`.

### Écritures

- `GET /acc/entries?status=&journalId=&limit=`, `GET /acc/entries/:id`.
- `POST /acc/entries/:id/validate` — numérotation définitive atomique (`ACH-2026-00001`...), passe la facture liée en `ACCOUNTED`. Idempotent.
- `POST /acc/entries/:id/reverse` — `{reason?}` : extourne (seul moyen de corriger une écriture validée).

### Règles

- `GET /acc/rules`, `POST /acc/rules` — `{supplierId?, keyword?, accountId, priority?}`, `PUT /acc/rules/:id`, `DELETE /acc/rules/:id`.

### Tableau de bord

- `GET /acc/dashboard` — `{byStatus, pendingCount, pendingHt, pendingTtc, blockingCount}`.

### Import par email (`/wa/graphMail/...`, onglet "Import email" du panneau)

Réutilise le même abonnement webhook Microsoft Graph que l'import de
tickets support (`src/lib/graph.ts`, `src/routes/graphMail.ts`) —
`GraphMailSubscription.purpose` distingue désormais plusieurs boîtes
surveillées en parallèle (`"tickets"` | `"accounting"`), chacune avec au
plus un abonnement actif. Pour la boîte comptabilité, chaque pièce jointe
d'un email reçu dont le type MIME est accepté (PDF/JPEG/PNG/TIFF/XML)
devient une facture d'achat via `processUploadedDocument(null, {..., source:
"email"})` — la déduplication par hash SHA-256 protège déjà contre la
livraison "at least once" de Graph, sans bookkeeping supplémentaire. La
direction est toujours `"purchase"` (périmètre phase 1) : une boîte
recevant des copies de factures de vente ne serait pas traitée
différemment.

- `GET /graphMail/status?purpose=accounting`
- `POST /graphMail/activate` — `{purpose:"accounting", mailbox}` (mailbox obligatoire, pas de valeur par défaut contrairement au purpose "tickets" qui reprend `SmtpConfig.supportFromEmail`).
- `POST /graphMail/deactivate` — `{purpose:"accounting"}`

**Mise en service côté Azure AD** : même app que pour les tickets support
(cf. `docs/microsoft-graph-inbound-tickets.md`) — si l'app a une
`ApplicationAccessPolicy` Exchange restreignant les boîtes accessibles
(`-PolicyScopeGroupId`), étendre son groupe de sécurité pour inclure la
nouvelle boîte (ex. `administration@sesame-technology.com`), sans quoi
Graph refusera les appels sur cette boîte malgré la permission `Mail.Read`
au niveau de l'app.

## Cycle de vie d'une facture

```
upload → RECEIVED
       → (texte natif suffisant ?) → EXTRACTED | CHECK_REQUIRED
       → PUT (corrections) → toujours EXTRACTED/CHECK_REQUIRED
       → POST .../validate → VALIDATED (+ écriture DRAFT générée)
       → POST .../entries/:entryId/validate → facture ACCOUNTED, écriture numérotée
       → (erreur post-validation) → extourne de l'écriture, jamais de suppression
```

## Limite connue

L'heuristique de raison sociale émetteur (`issuerName`, confiance 0.3 —
première ligne du texte qui n'est ni une date ni un montant) peut se
tromper si le document commence par un titre ("FACTURE", un en-tête de
mise en page...) avant le nom réel de l'entreprise. C'est une limite
assumée d'un moteur déterministe sans compréhension sémantique : le
rapprochement fournisseur par SIRET/TVA/SIREN reste fiable dans ce cas
(il ne dépend pas de `issuerName`), mais une fiche auto-créée sur un
document mal formé peut porter un nom incorrect — à corriger manuellement
via l'onglet Fournisseurs le cas échéant.
