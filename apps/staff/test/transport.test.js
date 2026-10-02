import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker, validateAuthorityUrl, sanitizedResult } from '../electron/transport.js';

test('HTTP is explicit loopback-only; remote/Atlas/credentials/redirect targets refused', () => {
  assert.equal(validateAuthorityUrl('http://127.0.0.1:4100', true), 'http://127.0.0.1:4100');
  for (const url of ['http://127.0.0.1:4100', 'http://192.168.1.3:4100', 'https://example.com:4100', 'http://user:password@127.0.0.1:4100', 'http://127.0.0.1:4100/other', 'http://127.0.0.1:4000']) assert.throws(() => validateAuthorityUrl(url, false));
  assert.throws(() => validateAuthorityUrl('http://192.168.1.3:4100', true));
});
test('session/challenge never reach renderer and polling never calls activity', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/auth/login') ? { token: 'private-token', challenge: 'private-challenge', user: { username: 'synthetic' } } : { user: { username: 'synthetic' } });
  };
  const broker = createBroker({ url: 'http://127.0.0.1:4100', demoMode: true, request });
  const result = await broker.signIn({ username: 'synthetic', password: 'synthetic test phrase' });
  assert.equal(result.token, undefined); assert.equal(result.challenge, undefined);
  await broker.sessionStatus(); await broker.sessionStatus();
  assert.equal(calls.some(call => call.url.endsWith('/auth/activity')), false);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-token');
  await broker.signOut(); await assert.rejects(broker.sessionStatus(), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(sanitizedResult({ token: 'secret', challenge: 'secret', kind: 'mfa' }), { kind: 'mfa' });
});
test('authority loss refuses access rather than returning cached account', async () => {
  const broker = createBroker({ url: 'http://127.0.0.1:4100', demoMode: true, request: async () => { throw new Error('network'); } });
  await assert.rejects(broker.signIn({ username: 'synthetic', password: 'not real' }), { code: 'AUTHORITY_UNAVAILABLE' });
});

test('late authentication responses cannot resurrect credentials after sign-out or forget', async () => {
  for (const action of ['signOut', 'forget']) {
    let finish;
    const request = async url => url.endsWith('/auth/login') ? new Promise(resolve => { finish = resolve; }) : Response.json({ signedOut: true });
    const broker = createBroker({ url: 'http://127.0.0.1:4100', demoMode: true, request });
    const pending = broker.signIn({ username: 'synthetic', password: 'synthetic test phrase' });
    await broker[action]();
    finish(Response.json({ token: 'synthetic-late-token', challenge: 'synthetic-late-challenge', user: { username: 'synthetic' } }));
    await assert.rejects(pending, { code: 'ACTION_SUPERSEDED' });
    await assert.rejects(broker.workspace(), { code: 'AUTH_REQUIRED' });
    await assert.rejects(async () => broker.enrollment(), { code: 'CHALLENGE_REQUIRED' });
  }
});

test('public health polling may finish during sign-in without cancelling the new credentials', async () => {
  let finish;
  const request = async url => url.endsWith('/health') ? new Promise(resolve => { finish = resolve; }) : Response.json(url.endsWith('/auth/login') ? { token: 'synthetic-current-token', user: { username: 'synthetic' } } : { heading: 'Staff workspace' });
  const broker = createBroker({ url: 'http://127.0.0.1:4100', demoMode: true, request });
  const pending = broker.status();
  await broker.signIn({ username: 'synthetic', password: 'synthetic test phrase' });
  finish(Response.json({ status: 'ok', database: 'connected' }));
  assert.equal((await pending).status, 'ok');
  assert.equal((await broker.workspace()).heading, 'Staff workspace');
});
