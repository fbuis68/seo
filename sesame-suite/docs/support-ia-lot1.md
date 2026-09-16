# Assistant support IA — LOT 1

Trois fonctions, dans l'ordre où elles ont été développées (cf. cahier des
charges du 16/09/2026) :

1. **Recherche automatique de cas similaires** — à l'ouverture d'un ticket,
   recherche sémantique (pas seulement mots-clés) dans l'historique des
   tickets déjà résolus.
2. **Proposition automatique de réponse par IA** — génère une réponse à
   partir du ticket, des cas similaires et des FAQ publiées. Ne part
   jamais automatiquement : validation humaine obligatoire.
3. **Transformer une résolution en FAQ** — capitalise un ticket résolu en
   brouillon de FAQ structuré, jamais publié automatiquement.

## Fournisseurs IA

Deux fournisseurs distincts, volontairement :

- **Anthropic Claude** — génère tout le texte (réponse suggérée,
  reformulations, FAQ). Claude n'a pas d'API d'embeddings native.
- **OpenAI** (`text-embedding-3-small`) — uniquement pour vectoriser les
  textes (recherche sémantique). Aucun texte n'est généré par ce
  fournisseur.

### Variables d'environnement à définir en production

```
ANTHROPIC_API_KEY="..."
ANTHROPIC_MODEL="claude-sonnet-5"      # optionnel, valeur par défaut
OPENAI_API_KEY="..."
OPENAI_EMBEDDING_MODEL="text-embedding-3-small"  # optionnel, valeur par défaut
```

Absentes : les routes IA répondent simplement `configured:false` (panneau
« Assistant support » discret côté CRM), ou 503 côté FAQ — le reste de
l'application n'est jamais affecté. **Ne jamais coller ces clés dans un
message de chat ou un commit** — les définir directement dans le `.env` du
serveur de production.

## Architecture (volontairement minimale)

Pas de pgvector, pas de base vectorielle externe : les vecteurs
(1536 dimensions) sont stockés en colonnes `Float[]` Postgres
(`CrmTicket.embedding`, `Faq.embedding`) et comparés par similarité
cosinus **en mémoire côté Node** (`lib/aiEmbeddings.ts`). Volumétrie d'un
support mono-produit largement compatible avec cette approche — à
reconsidérer seulement si le nombre de tickets/FAQ indexés devient
massif (cf. cahier des charges, "ne pas surdimensionner l'architecture").

Pas de tables `knowledge_chunks`/`embeddings` séparées : chaque ticket et
chaque FAQ porte directement son propre vecteur.

### Modèles ajoutés (`prisma/schema.prisma`)

- `CrmTicket.module`, `.resolutionSummary`, `.embedding`, `.embeddingUpdatedAt`
- `Faq` — question/variantes/réponses/procédure/module/catégorie/mots-clés/tags/statut/embedding/ticket source
- `AiSuggestion` — historique complet de chaque proposition de réponse (texte proposé / modifié / envoyé, confiance, sources, statut)

### Fichiers serveur

| Fichier | Rôle |
|---|---|
| `src/lib/aiEmbeddings.ts` | Client OpenAI embeddings + similarité cosinus |
| `src/lib/aiSimilarTickets.ts` | Recherche de cas similaires + FAQ pertinentes |
| `src/lib/aiClaude.ts` | Client Claude (réponse suggérée, transformations, génération FAQ) |
| `src/lib/aiIndexing.ts` | Indexation (embedding) d'un ticket résolu / d'une FAQ publiée |
| `src/routes/crmTicket.ts` | `GET /crmTicket/similar`, `POST /crmTicket/aiSuggest`, `POST /crmTicket/aiSuggestTransform` |
| `src/routes/faq.ts` | CRUD FAQ + `POST /faq/generateFromTicket` |
| `scripts/backfill-ticket-embeddings.ts` | Rattrapage ponctuel pour les tickets déjà résolus avant la mise en place de l'assistant |

## Point de vigilance : connaissance générique vs données propres au client

Le prompt système de `lib/aiClaude.ts` (constante `SAFETY_RULES`) interdit
explicitement de reprendre des données nominatives/contractuelles/commerciales
d'un ticket source dans une réponse adressée à un autre client — seule la
CONNAISSANCE DE RÉSOLUTION (comment le problème a été réglé) doit être
réutilisée. Cette règle est répétée dans les trois prompts (réponse
suggérée, reformulation, génération de FAQ).

## Fonctionnement

- Un ticket passe en **Résolu** ou **Fermé** → indexation automatique
  (asynchrone, n'échoue jamais la requête HTTP) : `resolutionSummary`
  (déduit du dernier message agent de type "reply", ou renseigné
  manuellement via le champ dédié) + embedding.
- Ouverture d'un ticket → panneau **Assistant support (IA)** :
  - **Cas similaires** : calcul à la volée de l'embedding du ticket
    interrogé (sujet + message client), comparaison aux tickets déjà
    indexés.
  - **Réponse suggérée** : bouton "Générer une réponse" → Claude construit
    une proposition à partir des cas similaires + FAQ publiées
    pertinentes. Actions : Utiliser / Envoyer / Régénérer / Raccourcir /
    Plus pédagogique / Plus technique / Copier. Chaque génération/
    transformation crée une nouvelle ligne `AiSuggestion` (audit complet),
    la précédente passe en `discarded`.
  - **Capitalisation** (tickets Résolu/Fermé uniquement) : bouton "Créer
    une FAQ à partir de ce ticket" → génère un brouillon, à compléter/
    publier depuis le nouveau panneau **FAQ** (menu latéral).
- Envoyer la réponse (bouton "Répondre" existant, ou "Envoyer" de
  l'assistant) trace le texte réellement envoyé sur la suggestion
  d'origine (`sentText`, statut `used` ou `edited` selon qu'il a été
  modifié).
- Une FAQ publiée est indexée (embedding) et devient une source possible
  pour de futures réponses suggérées — jamais un brouillon.

## Rattrapage des tickets déjà résolus

```bash
docker exec -it <conteneur> npx tsx scripts/backfill-ticket-embeddings.ts
```

À lancer une fois après la mise en place (nécessite `OPENAI_API_KEY`
configuré) pour indexer l'historique existant. Les tickets résolus après
coup sont indexés automatiquement, pas besoin de relancer ce script
régulièrement.

## Ce qui n'est PAS dans ce lot 1

Chatbot, réponse automatique envoyée sans validation, détection
d'incidents, dashboard avancé, portail self-service — cf. cahier des
charges, à ne développer qu'après validation de ce premier lot.
