# Image de test/démo — pas optimisée pour la production (pas de multi-stage,
# devDependencies conservées) : l'objectif est qu'un seul `docker compose up`
# suffise à lancer toute la stack, sans installer Node/PostgreSQL en local.
FROM node:22-alpine

# Prisma a besoin d'OpenSSL pour son moteur de requêtes sur Alpine/musl.
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public

# Génère le client Prisma pour la plateforme de l'image (linux-musl)
RUN npx prisma generate

COPY docker-entrypoint.sh ./
# Normalise les fins de ligne (CRLF -> LF) au cas où le fichier aurait été
# récupéré avec des fins de ligne Windows (ex: git core.autocrlf=true) —
# sinon le shebang casse avec "no such file or directory" au démarrage.
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
