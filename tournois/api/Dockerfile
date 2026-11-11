FROM node:22-alpine AS build
WORKDIR /app
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY api/migrations ./migrations
USER node
EXPOSE 4100
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/src/main.js"]
