import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { validateTarget } from '../src/config.js';
import { createVault, dpapi } from '../src/local-security.js';

test('database guard refuses public/Atlas/non-isolated targets', () => {
  const target = { host: '127.0.0.1', port: 27018, database: 'capstone_staff_dev', replicaSet: 'capstoneStaffDev' };
  validateTarget(target);
  for (const change of [{ host: 'cluster.mongodb.net' }, { port: 27017 }, { database: 'medical_center' }, { replicaSet: 'other' }]) assert.throws(() => validateTarget({ ...target, ...change }));
});
test('authenticated MFA encryption rejects corruption/wrong key', () => {
  const vault = createVault(randomBytes(32).toString('base64'));
  const record = vault.encrypt('synthetic-only-factor');
  assert.equal(vault.decrypt(record), 'synthetic-only-factor');
  assert.equal(JSON.stringify(record).includes('synthetic-only-factor'), false);
  assert.throws(() => createVault(randomBytes(32).toString('base64')).decrypt(record));
  assert.throws(() => vault.decrypt({ ...record, tag: randomBytes(16).toString('base64') }));
  vault.destroy();
});
test('Windows DPAPI roundtrip uses no plaintext key file', { skip: process.platform !== 'win32' }, async () => {
  const privateValue = randomBytes(32);
  const wrapped = await dpapi(privateValue, 'Protect');
  assert.notDeepEqual(wrapped, privateValue);
  assert.deepEqual(await dpapi(wrapped, 'Unprotect'), privateValue);
});
