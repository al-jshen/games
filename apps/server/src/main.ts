import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Serve the built web app when it exists. In the Docker image it sits at `/app/web`; in a workspace
 * checkout it is `apps/web/dist`. Absent either, the server still runs API + WebSocket, which is
 * all a bot needs.
 */
function findWebRoot(): string | null {
  const candidates = [
    process.env.WEB_ROOT,
    resolve(HERE, '../../web/dist'),
    resolve(HERE, '../../../apps/web/dist'),
    resolve(HERE, '../web'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'index.html'))) return resolve(dir);
  }
  return null;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const webRoot = findWebRoot();

const server = await startServer({ port, host, dataDir, webRoot });

console.log(`games server listening on ${server.url}`);
console.log(`  websocket   ${server.url.replace('http', 'ws')}/ws`);
console.log(`  web app     ${webRoot ?? '(not built - run `npm run build` in apps/web)'}`);
console.log(`  replays     ${dataDir} (${process.env.REPLAY_STORE ?? 'sqlite'})`);
if (!process.env.SESSION_SECRET) {
  console.log('  note: SESSION_SECRET is unset, so a random one was generated.');
  console.log('        Set it to keep reconnect tokens valid across restarts.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    void server.close().then(() => process.exit(0));
  });
}
