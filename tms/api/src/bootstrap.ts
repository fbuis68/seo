import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { config } from './config';

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: process.env.NODE_ENV === 'test' ? false : undefined });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '2mb' });
  app.use((req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // CORS : endpoints publics + widget ouverts aux origines du site ; API privée à l'application.
    const origin = req.headers.origin as string | undefined;
    const isPublic = req.path.startsWith('/api/v1/public/') || req.path.startsWith('/embed/');
    const allowed = origin && (isPublic ? config.publicOrigins.includes(origin) || config.publicOrigins.includes('*') : origin === config.appUrl);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
    next();
  });
  // Widget de souscription servi par l'API (intégrable sur tout site, dont WordPress).
  const embedDir = process.env.EMBED_DIR ?? [join(__dirname, '..', '..', 'embed'), join(__dirname, '..', '..', '..', 'embed')].find((p) => existsSync(p));
  if (embedDir) app.useStaticAssets(embedDir, { prefix: '/embed/v1/', maxAge: '5m' });
  return app;
}
