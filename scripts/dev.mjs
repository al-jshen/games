#!/usr/bin/env node
/**
 * One command for local development: build the workspace packages, start the API/WebSocket server,
 * and start Vite with its dev server proxying to it.
 *
 * The proxy matters beyond convenience: it keeps the app and its WebSocket on a single origin in dev
 * exactly as they are in production, so there is no CORS special case that only exists locally.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = process.env.PORT ?? '8787';
const children = [];
let shuttingDown = false;

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  });
  children.push({ name, child });

  const prefix = `[${name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited (${signal ?? code}); shutting everything down\n`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

// Build once up front so the server has something to run; Vite serves the UI from source and
// hot-reloads, and `tsc -b --watch` keeps the server's build fresh.
const build = spawn('npm', ['run', 'typecheck'], { cwd: ROOT, stdio: 'inherit' });
build.on('exit', (code) => {
  if (code !== 0) {
    process.stdout.write('\nBuild failed; not starting.\n');
    process.exit(code ?? 1);
  }

  run('tsc', 'npx', ['tsc', '-b', '--watch', '--preserveWatchOutput', 'apps/server']);
  run('server', 'node', ['--watch', 'apps/server/dist/main.js'], {
    env: {
      PORT: SERVER_PORT,
      // Keep reconnect tokens valid across the frequent restarts a watcher causes.
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'local-development-session-secret',
      // Vite serves the UI in dev, so the server should not also serve a stale build.
      WEB_ROOT: '',
    },
  });
  run('web', 'npx', ['vite', '--host'], {
    env: { GAMES_SERVER: `http://localhost:${SERVER_PORT}` },
  });

  process.stdout.write(`\nOpen http://localhost:5173 (server API on :${SERVER_PORT})\n\n`);
});
