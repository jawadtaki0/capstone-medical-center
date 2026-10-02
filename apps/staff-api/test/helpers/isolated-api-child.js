import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { connectStaffDatabase } from '../../src/db.js';
import { createVault } from '../../src/local-security.js';
import { assertIsolatedTestTarget, TEST_DATABASE } from './security-fixture.js';

// Dedicated test entry point: no configurable database, fixed-port listener,
// account provisioning, database cleanup, or Mongo process management.
let connection;
let vault;
let server;
let stopping;

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (server) {
      const captured = server;
      server = undefined;
      captured.closeAllConnections();
      await new Promise(resolve => captured.close(resolve));
    }
    if (connection) {
      const captured = connection;
      connection = undefined;
      await captured.client.close();
    }
    vault?.destroy();
    vault = undefined;
  })();
  return stopping;
}

async function finish(exitCode) {
  try { await stop(); } catch { exitCode = 1; }
  finally { process.exit(exitCode); }
}

process.on('message', message => {
  if (message?.type === 'stop') void finish(0);
});
process.on('disconnect', () => { void finish(0); });
process.on('SIGINT', () => { void finish(0); });
process.on('SIGTERM', () => { void finish(0); });
process.on('uncaughtException', () => { void finish(1); });
process.on('unhandledRejection', () => { void finish(1); });

try {
  if (!process.argv.includes('--isolated-test-fixture') || !process.send) throw new Error('Test child requires its owning test runner.');
  connection = await connectStaffDatabase({ database: TEST_DATABASE, demoMode: true });
  assertIsolatedTestTarget(connection);
  vault = createVault(connection.config.key);
  server = createApp({ ...connection, vault, demoMode: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || address.address !== '127.0.0.1' || [4100, 4101].includes(address.port)) throw new Error('Test child listener was not isolated.');
  // IPC carries only readiness metadata, never accounts, credentials or tokens.
  process.send({ type: 'ready', port: address.port });
} catch {
  process.send?.({ type: 'failed' });
  await finish(1);
}
