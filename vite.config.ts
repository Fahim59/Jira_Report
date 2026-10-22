import { defineConfig } from 'vite';

// Frontend lives in web/ and builds into dist/web, which Fastify serves in production.
// In dev (`npm run dev:web`), /api is proxied to the Fastify server.
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.PORT ?? 8000}` },
  },
});
