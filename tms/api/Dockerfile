FROM node:22-alpine AS build
WORKDIR /app
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
RUN npx tsc -p . && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY embed /embed
ENV EMBED_DIR=/embed
USER node
EXPOSE 4000
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/src/main.js"]
