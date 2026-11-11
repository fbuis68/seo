import 'reflect-metadata';
import { createApp } from './bootstrap';
import { config } from './config';
import { ResultsService } from './modules/tournament/results';

createApp().then(async (app) => {
  app.enableShutdownHooks();
  await app.listen(config.port);
  // Échéances de confirmation des scores (validation automatique ou alerte de l'organisateur).
  if (config.sweepSeconds > 0) {
    const results = app.get(ResultsService);
    setInterval(() => void results.sweepExpired().catch((e) => console.error('[sweep]', e.message)), config.sweepSeconds * 1000).unref();
  }
  console.log(`API tournois prête sur le port ${config.port}`);
});
