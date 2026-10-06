import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En développement, l'API est servie via le proxy (même origine, pas de CORS).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000', '/embed': 'http://localhost:4000' } },
});
