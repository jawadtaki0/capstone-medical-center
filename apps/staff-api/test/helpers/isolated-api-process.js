import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD_FILE = fileURLToPath(new URL('./isolated-api-child.js', import.meta.url));
const REQUEST_PATHS = new Set(['/auth/login', '/auth/session', '/workspace']);

export async function startIsolatedApiProcess() {
  const child = fork(CHILD_FILE, ['--isolated-test-fixture'], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let exited = false;
  const exit = new Promise(resolve => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  function waitForExit(milliseconds) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      exit.then(() => { clearTimeout(timer); resolve(); });
    });
  }
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (exited) return;
      if (child.connected) child.send({ type: 'stop' }, () => {});
      await waitForExit(5000);
      if (!exited) {
        // Fallback is restricted to the exact child this helper spawned.
        child.kill();
        await waitForExit(5000);
      }
      if (!exited) throw new Error('Owned isolated test API did not stop.');
    })();
    return stopping;
  }

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated test API startup timed out.')), 20000);
      const fail = () => { clearTimeout(timer); reject(new Error('Isolated test API startup failed.')); };
      child.once('error', fail);
      child.once('exit', fail);
      child.on('message', message => {
        if (message?.type === 'failed') { fail(); return; }
        if (message?.type !== 'ready' || !Number.isInteger(message.port)
          || message.port <= 0 || message.port > 65535 || [4100, 4101].includes(message.port)) return;
        clearTimeout(timer);
        child.removeListener('error', fail);
        child.removeListener('exit', fail);
        resolve(message.port);
      });
    });
  } catch (error) { await stop(); throw error; }

  return {
    pid: child.pid,
    stop,
    async request(path, { body, token } = {}) {
      if (!REQUEST_PATHS.has(path) || exited || stopping) throw new Error('Invalid or stopped isolated test API request.');
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: 'app://staff', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
