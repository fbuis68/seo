import 'reflect-metadata';
import { createApp } from './bootstrap';
import { config } from './config';
import { startWorkerLoop } from './worker-loop';

createApp().then(async (app) => {
  await app.listen(config.port);
  // En développement, le worker tourne dans le même processus (WORKER_INLINE=0 pour le désactiver).
  if (process.env.WORKER_INLINE !== '0' && !config.isProd) startWorkerLoop(app);
  console.log(`API prête sur ${config.publicApiUrl} (paiement : ${config.payment.provider})`);
});
