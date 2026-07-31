import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The rules here that actually earn their keep are the last two blocks: they make the
 * determinism and layering guarantees mechanical instead of a matter of remembering.
 */
/** Node globals used by the build tooling and the server. */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
};

/** Browser globals used by the web app and the game UIs. */
const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  WebSocket: 'readonly',
  Storage: 'readonly',
  KeyboardEvent: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.generated.ts', '**/.cache/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.mjs', 'apps/server/src/**/*.ts', 'tools/**/*', 'scripts/**/*'],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    files: ['apps/web/src/**/*', 'packages/games/*/src/ui/**/*', 'packages/client-sdk/src/**/*'],
    languageOptions: { globals: BROWSER_GLOBALS },
  },
  {
    // Game reducers must be pure functions of their inputs. `Math.random` and `Date.now` are the
    // two ways non-determinism sneaks in, and either one silently invalidates every stored replay
    // with no test failure anywhere. One rule kills the whole class.
    files: ['packages/games/*/src/**/*.ts'],
    ignores: ['packages/games/*/src/ui/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Game logic must be deterministic. Randomness comes from state.seed + rngCounter.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use RandomCursor seeded from state.seed instead.' },
        { object: 'Date', property: 'now', message: 'Game logic must not read the clock.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', '@games/protocol', '@games/client-sdk'],
              message:
                'Game modules must run in the browser and stay transport-agnostic. Only @games/engine and browser-safe libraries are allowed.',
            },
          ],
        },
      ],
    },
  },
  {
    // The server must never pull a game's React UI into its dependency graph.
    files: ['apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['*/ui', '**/ui'], message: 'The server must not import game UI.' }] },
      ],
    },
  },
);
