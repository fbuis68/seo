#!/bin/sh
set -e

echo "→ Applying database migrations…"
npx prisma migrate deploy

echo "→ Seeding demo data (Hôtel Churchill)…"
npx tsx prisma/seed.ts

echo "→ Starting server…"
exec npx tsx src/index.ts
