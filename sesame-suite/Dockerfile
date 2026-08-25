# Image de test/démo — pas optimisée pour la production (pas de multi-stage,
# devDependencies conservées) : l'objectif est qu'un seul `docker compose up`
# suffise à lancer toute la stack, sans installer Node/PostgreSQL en local.
FROM node:22-alpine

# Prisma a besoin d'OpenSSL pour son moteur de requêtes sur Alpine/musl.
RUN apk add --no-cache openssl

WORKDIR /app

# Numéro de version affiché dans l'interface (bas de la barre latérale du
# CRM/admin) et exposé sur GET /version — permet de vérifier depuis
# l'appli quel build tourne réellement après un déploiement. Reçu en
# argument de build (voir docker-compose.yml) plutôt que lu depuis .git :
# le contexte de build de ce Dockerfile est le dossier sesame-suite/, qui
# ne contient PAS .git (situé un niveau au-dessus, à la racine du dépôt) —
# on ne peut donc pas le COPY ici.
ARG GIT_SHA=inconnu
ARG GIT_TIME=""
RUN echo "$GIT_SHA" > BUILD_SHA.txt && echo "$GIT_TIME" > BUILD_TIME.txt

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
# Scripts ponctuels (ex. scripts/backfill-room-media.ts) — exécutés à la
# main via `docker exec` après déploiement, pas au démarrage, mais doivent
# être présents dans l'image pour ça (oublié initialement : le premier
# `docker exec ... npx tsx scripts/backfill-room-media.ts` en production a
# échoué avec ERR_MODULE_NOT_FOUND faute de ce COPY).
COPY scripts ./scripts

# Génère le client Prisma pour la plateforme de l'image (linux-musl)
RUN npx prisma generate

COPY docker-entrypoint.sh ./
# Normalise les fins de ligne (CRLF -> LF) au cas où le fichier aurait été
# récupéré avec des fins de ligne Windows (ex: git core.autocrlf=true) —
# sinon le shebang casse avec "no such file or directory" au démarrage.
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
