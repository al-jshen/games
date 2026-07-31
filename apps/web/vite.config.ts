import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.GAMES_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Point at workspace sources so `npm run dev` picks up engine and rules edits without a
    // separate build step -- and so the game reducer is bundled for client-side prediction.
    alias: [
      { find: '@games/engine', replacement: fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)) },
      { find: '@games/protocol', replacement: fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)) },
      { find: '@games/client-sdk', replacement: fileURLToPath(new URL('../../packages/client-sdk/src/index.ts', import.meta.url)) },
      { find: '@games/splendor-duel/ui', replacement: fileURLToPath(new URL('../../packages/games/splendor-duel/src/ui/index.tsx', import.meta.url)) },
      { find: '@games/splendor-duel', replacement: fileURLToPath(new URL('../../packages/games/splendor-duel/src/index.ts', import.meta.url)) },
      { find: '@games/tic-tac-toe/ui', replacement: fileURLToPath(new URL('../../packages/games/tic-tac-toe/src/ui/index.tsx', import.meta.url)) },
      { find: '@games/tic-tac-toe', replacement: fileURLToPath(new URL('../../packages/games/tic-tac-toe/src/index.ts', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    // Same-origin in production; in dev the proxy keeps the app and its socket on one origin too,
    // so there is no CORS special case that only exists locally.
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/healthz': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
