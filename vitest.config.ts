import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve workspace packages to source, so tests exercise what the app bundles rather than a
    // possibly-stale dist. The `./ui` entrypoints are source-only by design (they import CSS).
    alias: [
      { find: '@games/engine', replacement: fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url)) },
      { find: '@games/protocol', replacement: fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)) },
      { find: '@games/client-sdk', replacement: fileURLToPath(new URL('./packages/client-sdk/src/index.ts', import.meta.url)) },
      { find: '@games/splendor-duel/ui', replacement: fileURLToPath(new URL('./packages/games/splendor-duel/src/ui/index.tsx', import.meta.url)) },
      { find: '@games/splendor-duel', replacement: fileURLToPath(new URL('./packages/games/splendor-duel/src/index.ts', import.meta.url)) },
      { find: '@games/tic-tac-toe/ui', replacement: fileURLToPath(new URL('./packages/games/tic-tac-toe/src/ui/index.tsx', import.meta.url)) },
      { find: '@games/tic-tac-toe', replacement: fileURLToPath(new URL('./packages/games/tic-tac-toe/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['packages/**/test/**/*.test.{ts,tsx}', 'apps/**/test/**/*.test.{ts,tsx}'],
    // Property tests over full random playthroughs are the slowest thing here.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
