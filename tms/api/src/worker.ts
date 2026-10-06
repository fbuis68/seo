import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { startWorkerLoop } from './worker-loop';

/** Processus worker séparé (production) : file PostgreSQL, aucune exposition HTTP. */
NestFactory.createApplicationContext(AppModule).then((app) => {
  startWorkerLoop(app);
  console.log('Worker démarré');
});
