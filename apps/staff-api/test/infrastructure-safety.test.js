import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createAuthorityLifecycle } from '../src/server.js';
import { codeMatchesMarker, issueSetupCode, readVerifiedSetupCode,
  recoverPendingPublication, usableIssuedMarker, withSetupLock } from '../scripts/bootstrap.js';

// No Mongo connection, private runtime file, DPAPI invocation, or real code is
// used here. The transaction and wrapping fakes are only fault-injection seams.
const wrap = async value => Buffer.from(value).reverse();
const unwrap = async value => Buffer.from(value).reverse();
const now = () => new Date('2040-01-01T12:00:00.000Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const marker = code => ({ _id: 'first-admin', status: 'issued', codeHash: hash(code),
  expiresAt: new Date(now().getTime() + 30 * 60000), attempts: 0 });

function deferred() {
  let resolveValue;
  let rejectValue;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise; rejectValue = rejectPromise;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function connection(ping = async () => {}) {
  return { db: { command: ping }, config: { key: 'synthetic-key' },
    client: { closes: 0, async close() { this.closes += 1; } } };
}

function dependencies(connectDatabase) {
  const vaults = [];
  return { connectDatabase, vaults, makeVault() {
    const vault = { destroys: 0, destroy() { this.destroys += 1; } };
    vaults.push(vault); return vault;
  }, makeApp: () => (_request, response) => response.end('ready') };
}

function responseFor(lifecycle) {
  const response = { status: 200, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  lifecycle.handler({}, response);
  return response;
}

async function temporaryDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'capstone-staff-bootstrap-test-'));
  try { return await action(directory); }
  finally {
    // Recursive cleanup is restricted to the exact directory this test created.
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'capstone-staff-bootstrap-test-')));
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeDatabase(initial = null, { accountCount = 0, auditFails = false } = {}) {
  const state = { marker: structuredClone(initial), events: [], transactions: 0, ended: 0 };
  const db = { collection(name) {
    if (name === 'accounts') return { countDocuments: async () => accountCount };
    if (name === 'installation_state') return {
      findOne: async () => structuredClone(state.marker),
      replaceOne: async (_filter, value) => { state.marker = structuredClone(value); },
    };
    if (name === 'security_events') return { insertOne: async value => {
      if (auditFails) throw new Error('Synthetic audit failure');
      state.events.push(structuredClone(value));
    } };
    throw new Error('Unexpected test collection.');
  } };
  const client = { startSession: () => ({ async withTransaction(action) {
    state.transactions += 1;
    const snapshot = structuredClone({ marker: state.marker, events: state.events });
    try { return await action(); }
    catch (error) { state.marker = snapshot.marker; state.events = snapshot.events; throw error; }
  }, async endSession() { state.ended += 1; } }) };
  return { db, client, state };
}

test('authority serializes concurrent connection and recovery attempts', async () => {
  const connect = deferred();
  let calls = 0;
  const first = connection();
  const options = dependencies(async () => { calls += 1; return connect.promise; });
  const lifecycle = createAuthorityLifecycle(options);
  const a = lifecycle.refresh();
  const b = lifecycle.refresh();
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(responseFor(lifecycle).status, 503);
  connect.resolve(first);
  await Promise.all([a, b]);
  assert.equal(responseFor(lifecycle).body, 'ready');
  await lifecycle.stop();
  assert.equal(first.client.closes, 1);
  assert.equal(options.vaults[0].destroys, 1);
});

test('failed captured connection is disposed once before recovery; overlapping pings cannot close its replacement', async () => {
  const ping = deferred();
  const first = connection(() => ping.promise);
  const second = connection();
  let calls = 0;
  const options = dependencies(async () => ++calls === 1 ? first : second);
  const lifecycle = createAuthorityLifecycle(options);
  await lifecycle.refresh();
  const pending = lifecycle.refresh();
  const overlapping = lifecycle.refresh();
  assert.equal(pending, overlapping);
  ping.reject(new Error('Synthetic outage'));
  await Promise.all([pending, overlapping]);
  assert.equal(calls, 2);
  assert.equal(first.client.closes, 1);
  assert.equal(options.vaults[0].destroys, 1);
  assert.equal(second.client.closes, 0);
  assert.equal(responseFor(lifecycle).body, 'ready');
  await lifecycle.stop();
  assert.equal(second.client.closes, 1);
});

test('vault or app construction failure cleans up the connected candidate and never publishes it', async () => {
  for (const failure of ['vault', 'app']) {
    const candidate = connection();
    const options = dependencies(async () => candidate);
    if (failure === 'vault') options.makeVault = () => { throw new Error('Synthetic key failure'); };
    else options.makeApp = () => { throw new Error('Synthetic app failure'); };
    const lifecycle = createAuthorityLifecycle(options);
    await lifecycle.refresh();
    assert.equal(candidate.client.closes, 1);
    assert.equal(responseFor(lifecycle).status, 503);
    if (failure === 'app') assert.equal(options.vaults[0].destroys, 1);
    await lifecycle.stop();
    assert.equal(candidate.client.closes, 1);
  }
});

test('shutdown waits for in-flight connect, disposes its candidate and forbids reconnect', async () => {
  const pending = deferred();
  const candidate = connection();
  let calls = 0;
  const options = dependencies(async () => { calls += 1; return pending.promise; });
  const lifecycle = createAuthorityLifecycle(options);
  const refresh = lifecycle.refresh();
  const stop = lifecycle.stop();
  pending.resolve(candidate);
  await Promise.all([refresh, stop]);
  await lifecycle.refresh();
  await lifecycle.stop();
  assert.equal(calls, 1);
  assert.equal(candidate.client.closes, 1);
  assert.equal(options.vaults.length, 0);
  assert.equal(responseFor(lifecycle).status, 503);
});

test('private setup lock refuses competing issuers and is released even when the action fails', async () => {
  await temporaryDirectory(async directory => {
    await withSetupLock(directory, async () => {
      await assert.rejects(withSetupLock(directory, async () => {}), /stale lock/);
    });
    await assert.rejects(withSetupLock(directory, async () => { throw new Error('Synthetic failure'); }), /Synthetic failure/);
    await withSetupLock(directory, async () => {});
    assert.equal((await readdir(directory)).length, 0);
  });
});

test('setup marker validation requires the current digest, explicit issued lifecycle, expiry and attempts', () => {
  const code = Buffer.from('synthetic-only-private-code');
  const current = marker(code);
  assert.equal(codeMatchesMarker(code, current), true);
  assert.equal(codeMatchesMarker(Buffer.from('other synthetic code'), current), false);
  assert.equal(codeMatchesMarker(code, { ...current, codeHash: 'invalid' }), false);
  assert.equal(usableIssuedMarker(current, now()), true);
  for (const changes of [{ status: 'claimed' }, { expiresAt: now() }, { attempts: 5 }, { attempts: -1 }, { attempts: undefined }]) {
    assert.equal(usableIssuedMarker({ ...current, ...changes }, now()), false);
  }
});

test('private reveal rejects mismatched or closed markers and clears the unwrapped rejected buffer', async () => {
  await temporaryDirectory(async directory => {
    const code = Buffer.from('synthetic-only-private-code');
    await writeFile(join(directory, 'setup-code.dpapi'), await wrap(code));
    const good = await readVerifiedSetupCode({ directory, state: marker(code), unwrap, at: now() });
    assert.equal(good.equals(code), true);
    good.fill(0);
    const rejectedBuffer = Buffer.from(code);
    await assert.rejects(readVerifiedSetupCode({ directory, state: marker('other synthetic code'),
      unwrap: async () => rejectedBuffer, at: now() }), /does not match/);
    assert.equal(rejectedBuffer.every(value => value === 0), true);
    await assert.rejects(readVerifiedSetupCode({ directory, state: { ...marker(code), status: 'claimed' }, unwrap, at: now() }), /unavailable/);
  });
});

test('failed key protection does not invalidate an existing issued code or enter a database transaction', async () => {
  await temporaryDirectory(async directory => {
    const previous = marker('previous synthetic code');
    const fake = fakeDatabase(previous);
    await assert.rejects(issueSetupCode({ ...fake, directory, reissue: true, now,
      wrap: async () => { throw new Error('Synthetic DPAPI failure'); } }), /DPAPI failure/);
    assert.deepEqual(fake.state.marker, previous);
    assert.equal(fake.state.transactions, 0);
    assert.equal(fake.state.ended, 1);
    assert.equal((await readdir(directory)).length, 0);
  });
});

test('failed atomic publication recovers the same committed code without issuing again or changing its marker', async () => {
  await temporaryDirectory(async directory => {
    const fake = fakeDatabase();
    const publishedPath = join(directory, 'setup-code.dpapi');
    await mkdir(publishedPath); // Deliberately make rename fail, without real disk/runtime changes.
    await assert.rejects(issueSetupCode({ ...fake, directory, now, wrap }));
    assert.equal(fake.state.marker.status, 'issued');
    assert.equal(fake.state.events.length, 1);
    const beforeRecovery = structuredClone(fake.state.marker);
    await rmdir(publishedPath);
    assert.equal(await recoverPendingPublication({ directory, state: fake.state.marker, unwrap, at: now() }), true);
    assert.deepEqual(fake.state.marker, beforeRecovery);
    assert.equal(fake.state.transactions, 1);
    const code = await readVerifiedSetupCode({ directory, state: fake.state.marker, unwrap, at: now() });
    assert.equal(codeMatchesMarker(code, beforeRecovery), true);
    code.fill(0);
    assert.deepEqual(await readdir(directory), ['setup-code.dpapi']);
  });
});

test('failed exclusive staging write never changes the prior database marker or overwrites pending bytes', async () => {
  await temporaryDirectory(async directory => {
    const previous = marker('previous synthetic code');
    const fake = fakeDatabase(previous);
    const pending = join(directory, 'setup-code.pending.dpapi');
    const previousBytes = Buffer.from('synthetic protected pending bytes');
    await writeFile(pending, previousBytes);
    await assert.rejects(issueSetupCode({ ...fake, directory, reissue: true, now, wrap }));
    assert.equal(fake.state.transactions, 0);
    assert.deepEqual(fake.state.marker, previous);
    assert.deepEqual(await readFile(pending), previousBytes);
  });
});

test('claimed bootstrap or existing accounts cannot be replaced by explicit reissue', async () => {
  await temporaryDirectory(async directory => {
    for (const options of [{ initial: { ...marker('synthetic'), status: 'claimed' } }, { initial: null, accountCount: 1 }]) {
      const fake = fakeDatabase(options.initial, options);
      await assert.rejects(issueSetupCode({ ...fake, directory, reissue: true, now, wrap }), /closed|accounts forbid/);
      assert.deepEqual(fake.state.marker, options.initial);
      assert.equal(fake.state.events.length, 0);
      // Reconcile a failed transaction's candidate before the next test issue.
      if (options.initial?.status === 'claimed') {
        await assert.rejects(recoverPendingPublication({ directory, state: fake.state.marker, unwrap, at: now() }), /closed/);
        await rm(join(directory, 'setup-code.pending.dpapi'));
      } else await recoverPendingPublication({ directory, state: fake.state.marker, unwrap, at: now() });
    }
  });
});

test('audit failure leaves the prior issued marker and final private file intact; stale pending file cannot overwrite it', async () => {
  await temporaryDirectory(async directory => {
    const previousCode = Buffer.from('previous synthetic-only code');
    const previous = marker(previousCode);
    const fake = fakeDatabase(previous, { auditFails: true });
    const path = join(directory, 'setup-code.dpapi');
    await writeFile(path, await wrap(previousCode));
    const existingBytes = await readFile(path);
    await assert.rejects(issueSetupCode({ ...fake, directory, reissue: true, now, wrap }), /audit failure/);
    assert.deepEqual(fake.state.marker, previous);
    assert.equal(fake.state.events.length, 0);
    assert.equal(await recoverPendingPublication({ directory, state: fake.state.marker, unwrap, at: now() }), false);
    assert.deepEqual(await readFile(path), existingBytes);
  });
});
