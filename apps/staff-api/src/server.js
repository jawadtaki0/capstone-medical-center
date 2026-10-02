import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStaffDatabase } from './db.js';
import { createVault } from './local-security.js';
import { createApp } from './app.js';

// Own one captured connection/vault pair. Refreshes share a promise rather
// than overlapping interval callbacks that can close a newer connection.
export function createAuthorityLifecycle({
  database = 'capstone_staff_dev', connectDatabase = connectStaffDatabase,
  makeVault = createVault, makeApp = createApp, log = () => {},
} = {}) {
  let current;
  let refreshPromise;
  let stopping = false;
  const unavailable = JSON.stringify({ error: { code: 'AUTHORITY_UNAVAILABLE', message: 'The local staff authority is unavailable. No offline sign-in is permitted.' } });

  async function dispose(candidate) {
    if (!candidate) return;
    try { await candidate.connection.client.close(); } catch {}
    finally { try { candidate.vault?.destroy(); } catch {} }
  }

  async function refreshOnce() {
    if (stopping) return;
    const captured = current;
    if (captured) {
      try { await captured.connection.db.command({ ping: 1 }); return; }
      catch {
        if (current === captured) current = undefined;
        await dispose(captured);
      }
    }
    if (stopping) return;
    let candidate;
    try {
      const connection = await connectDatabase({ database, demoMode: true });
      candidate = { connection };
      if (stopping) { await dispose(candidate); return; }
      candidate.vault = makeVault(connection.config.key);
      candidate.app = makeApp({ ...connection, vault: candidate.vault, demoMode: true });
      if (stopping) { await dispose(candidate); return; }
      current = candidate;
      log('Staff authority connected to its isolated local database.');
    } catch {
      if (current === candidate) current = undefined;
      await dispose(candidate);
    }
  }

  return {
    handler(request, response) {
      if (current && !stopping) return current.app(request, response);
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(unavailable);
    },
    refresh() {
      if (stopping) return Promise.resolve();
      if (!refreshPromise) refreshPromise = refreshOnce().finally(() => { refreshPromise = undefined; });
      return refreshPromise;
    },
    async stop() {
      stopping = true;
      await refreshPromise;
      const captured = current;
      current = undefined;
      await dispose(captured);
    },
  };
}

async function run() {
  if (!process.argv.includes('--demo-loopback')) throw new Error('Explicit demo mode required.');
  const testMode = process.argv.includes('--test-database');
  const port = testMode ? 4101 : 4100;
  const authority = createAuthorityLifecycle({ database: testMode ? 'capstone_staff_test' : 'capstone_staff_dev', log: console.log });
  const server = createServer(authority.handler);
  let timer;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    // Stop accepting requests and drain existing responses before destroying
    // the vault they use; in-flight refresh candidates are also cleaned up.
    await new Promise(resolveClose => server.close(resolveClose));
    await authority.stop();
  }
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  server.on('error', () => { console.error('Staff listener failed.'); process.exitCode = 1; void stop(); });
  server.listen(port, '127.0.0.1', () => console.log(`Staff HTTP demo listening only on loopback port ${port}.`));
  async function check() {
    await authority.refresh();
    if (!stopping) timer = setTimeout(() => { void check(); }, 5000);
  }
  await check();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(() => { console.error('Staff API requires explicitly enabled local demo mode and the private runtime.'); process.exitCode = 1; });
}
