import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { writeFile, readFile, open, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStaffDatabase } from '../src/db.js';
import { dpapi, runtimeDirectory } from '../src/local-security.js';

export function codeMatchesMarker(code, state) {
  if (typeof state?.codeHash !== 'string' || !/^[a-f0-9]{64}$/.test(state.codeHash)) return false;
  return timingSafeEqual(createHash('sha256').update(code).digest(), Buffer.from(state.codeHash, 'hex'));
}

export function usableIssuedMarker(state, at = new Date()) {
  return state?.status === 'issued' && state.expiresAt instanceof Date
    && state.expiresAt > at && Number.isInteger(state.attempts) && state.attempts >= 0 && state.attempts < 5;
}

// CLI calls share a private lock. A process crash deliberately leaves a stale
// lock for explicit inspection; never guess that another issuer is inactive.
export async function withSetupLock(directory, action) {
  const path = join(directory, 'setup-code.lock');
  let lock;
  try { lock = await open(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another setup-code command or unresolved stale lock exists.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await action();
  } finally { await lock.close(); await unlink(path); }
}

// The protected pending file is durable before the database transaction.
// If atomic publication fails after commit, the next command can finish
// publishing that same code, without changing the database or issuing another.
export async function recoverPendingPublication({ directory, state, unwrap = value => dpapi(value, 'Unprotect'), at = new Date() }) {
  if (state && state.status !== 'issued') throw new Error('Bootstrap is permanently closed.');
  const pending = join(directory, 'setup-code.pending.dpapi');
  let wrapped;
  try { wrapped = await readFile(pending); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const code = await unwrap(wrapped);
  try {
    if (usableIssuedMarker(state, at) && codeMatchesMarker(code, state)) {
      await rename(pending, join(directory, 'setup-code.dpapi'));
      return true;
    }
    // A failed transaction left an unpublished candidate, or its issued code
    // expired. It cannot overwrite the separately validated current code.
    await unlink(pending);
    return false;
  } finally { code.fill(0); }
}

export async function readVerifiedSetupCode({ directory, state, unwrap = value => dpapi(value, 'Unprotect'), at = new Date() }) {
  if (!usableIssuedMarker(state, at)) throw new Error('Setup code is unavailable or expired.');
  const code = await unwrap(await readFile(join(directory, 'setup-code.dpapi')));
  if (!codeMatchesMarker(code, state)) {
    code.fill(0);
    throw new Error('Private setup file does not match the current issued marker.');
  }
  return code;
}

export async function issueSetupCode({ client, db, directory, reissue = false,
  wrap = value => dpapi(value, 'Protect'), now = () => new Date() }) {
  const code = Buffer.from(randomBytes(20).toString('hex'));
  const pending = join(directory, 'setup-code.pending.dpapi');
  const session = client.startSession();
  try {
    // Complete encryption and exclusive durable staging before invalidating
    // an old database hash. A failed wrap/write leaves that old code intact.
    await writeFile(pending, await wrap(code), { flag: 'wx', flush: true });
    await session.withTransaction(async () => {
      if (await db.collection('accounts').countDocuments({}, { session })) throw new Error('Existing accounts forbid bootstrap.');
      const current = await db.collection('installation_state').findOne({ _id: 'first-admin' }, { session });
      if (current && current.status !== 'issued') throw new Error('Bootstrap is permanently closed.');
      if (!reissue && usableIssuedMarker(current, now())) throw new Error('An unexpired code already exists.');
      await db.collection('installation_state').replaceOne({ _id: 'first-admin' }, {
        _id: 'first-admin', status: 'issued', codeHash: createHash('sha256').update(code).digest('hex'),
        expiresAt: new Date(now().getTime() + 30 * 60000), attempts: 0,
      }, { session, upsert: true });
      await db.collection('security_events').insertOne({ type: current ? 'bootstrap_code_reissued' : 'bootstrap_code_issued', occurredAt: now() }, { session });
    });
    const published = await db.collection('installation_state').findOne({ _id: 'first-admin' });
    if (!usableIssuedMarker(published, now()) || !codeMatchesMarker(code, published)) throw new Error('Setup marker changed before private publication.');
    await rename(pending, join(directory, 'setup-code.dpapi'));
  } finally { code.fill(0); await session.endSession(); }
}

async function run() {
  if (!process.argv.includes('--demo-loopback')) throw new Error('Explicit demo mode required.');
  await withSetupLock(runtimeDirectory, async () => {
    const { client, db } = await connectStaffDatabase({ demoMode: process.argv.includes('--demo-loopback') });
    try {
      let state = await db.collection('installation_state').findOne({ _id: 'first-admin' });
      if (state && state.status !== 'issued') throw new Error('Bootstrap is permanently closed.');
      await recoverPendingPublication({ directory: runtimeDirectory, state });
      if (process.argv.includes('--reveal')) {
        state = await db.collection('installation_state').findOne({ _id: 'first-admin' });
        const code = await readVerifiedSetupCode({ directory: runtimeDirectory, state });
        try {
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $v=[Console]::In.ReadToEnd(); [System.Windows.Forms.MessageBox]::Show($v,'Private first-Admin setup code — do not share or screenshot') | Out-Null"], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
          child.stdin.end(code);
          await new Promise((resolveClose, reject) => { child.on('error', reject); child.on('close', exitCode => exitCode === 0 ? resolveClose() : reject(new Error('Private setup display failed.'))); });
        } finally { code.fill(0); }
        return;
      }
      if (usableIssuedMarker(state) && !process.argv.includes('--reissue')) {
        // Do not report a usable private code if a failed/corrupt file cannot
        // actually be revealed. --reissue remains explicit, never automatic.
        const verified = await readVerifiedSetupCode({ directory: runtimeDirectory, state });
        verified.fill(0);
        console.log('An unexpired private code already exists; no replacement created.');
        return;
      }
      await issueSetupCode({ client, db, directory: runtimeDirectory, reissue: process.argv.includes('--reissue') });
      console.log('Private single-use setup code issued for 30 minutes. Use --reveal privately; no secret was printed.');
    } finally { await client.close(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(() => { console.error('Bootstrap refused or local authority unavailable. Inspect any unresolved private setup-code.lock; no automatic account was created.'); process.exitCode = 1; });
}
