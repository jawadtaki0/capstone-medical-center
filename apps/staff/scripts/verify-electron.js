import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { _electron as electron } from 'playwright';
import { generate } from 'otplib';
import { createApp } from '../../staff-api/src/app.js';
import { connectStaffDatabase } from '../../staff-api/src/db.js';
import { createVault } from '../../staff-api/src/local-security.js';
import { assertIsolatedTestTarget, STAFF_COLLECTIONS, syntheticProfile } from '../../staff-api/test/helpers/security-fixture.js';

// All accounts and secret-bearing screens stay inside the isolated test database.
// Never capture enrollment/backup-code screens or print credentials on failure.
const directory = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(directory, '../../../.local/staff-review');
let connection;
let vault;
let server;
let client;
let page;
let stage = 'connecting';
let clockOffset = 0;
let savedBackupCode;
const errors = [];
const externalRequests = [];
const username = `synthetic.${randomBytes(6).toString('hex')}`;
const password = `Synthetic review ${randomBytes(24).toString('base64url')}`;
const setupCode = randomBytes(20).toString('hex');
const packaged = process.argv.includes('--packaged');
const applicationPath = resolve(directory, '..');
const executablePath = packaged ? join(applicationPath, 'release', 'win-unpacked', 'Cedar Staff Development.exe') : undefined;

async function startServer() {
  server = createApp({ ...connection, vault, clock: () => new Date(Date.now() + clockOffset), demoMode: true }).listen(4101, '127.0.0.1');
  await once(server, 'listening');
}
async function stopServer() {
  const current = server; server = undefined;
  if (current) { current.closeAllConnections(); await new Promise(resolve => current.close(resolve)); }
}
async function launch() {
  client = await electron.launch({ ...(executablePath ? { executablePath, args: ['--demo-loopback'] } : { args: [applicationPath, '--demo-loopback'] }), env: { ...process.env, STAFF_API_URL: 'http://127.0.0.1:4101' }, timeout: 30000 });
  page = await client.firstWindow();
  page.on('pageerror', () => errors.push('renderer-error'));
  page.on('console', message => { if (message.type() === 'error' || /Electron Security Warning/.test(message.text())) errors.push('console-or-security-error'); });
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push('renderer-network-attempt'); });
  await page.getByRole('heading', { name: 'Sign in to Cedar Staff' }).waitFor();
}
async function dimensions(width, height) {
  await client.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Horizontal overflow.');
}
async function signIn() {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password or passphrase', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function totp() {
  const account = await connection.db.collection('accounts').findOne({ username });
  const cipher = account.pendingMfaSecretCipher || account.mfa?.secretCipher;
  const secret = vault.decrypt(cipher);
  if (account.mfa?.lastAcceptedStep >= Math.floor(Date.now() / 30000)) {
    // Adjacent-step tolerance is the approved policy; do not weaken replay checks.
    return generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  }
  return generate({ secret });
}

try {
  connection = await connectStaffDatabase({ database: 'capstone_staff_test', demoMode: true });
  assertIsolatedTestTarget(connection);
  vault = createVault(connection.config.key);
  for (const name of STAFF_COLLECTIONS) await connection.db.collection(name).deleteMany({});
  await connection.db.collection('installation_state').insertOne({ _id: 'first-admin', status: 'issued', codeHash: createHash('sha256').update(setupCode).digest('hex'), expiresAt: new Date(Date.now() + 30 * 60000), attempts: 0 });
  await mkdir(evidence, { recursive: true });
  await startServer();
  stage = 'packaged local UI';
  await launch();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => Object.keys(window.staffApi).length), 12);
  await dimensions(1080, 800);
  await page.screenshot({ path: join(evidence, `${packaged ? 'packaged-' : ''}sign-in.png`) });
  // Check the real native-window keyboard path, not only programmatic focus.
  await page.getByRole('heading', { name: 'Sign in to Cedar Staff' }).focus();
  for (const expected of ['username', 'current-password']) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('autocomplete')), expected);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Use the private first-Admin setup code' }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Set up the first Admin' }).waitFor();
  await dimensions(360, 800);
  await page.screenshot({ path: join(evidence, 'setup-narrow-empty.png'), fullPage: true });
  await dimensions(1080, 800);
  stage = 'setup claim';
  const profile = syntheticProfile();
  for (const [label, value] of [['First name',profile.firstName], ['Last name',profile.lastName], ['Father’s given name',profile.fatherName], ['Mother’s name (given name only)',profile.motherName], ['Date of birth',profile.dateOfBirth], ['Employment start date',profile.employmentStartDate], ['Address',profile.address], ['Phone',profile.phone], ['Individual email',profile.email], ['Degree title / subject',profile.qualification.title], ['Awarding university / institution',profile.qualification.institution], ['Username',username], ['Private single-use setup code',setupCode], ['Choose a password or passphrase',password], ['Confirm password',password]]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Administration', { exact: true }).check();
  await page.getByRole('button', { name: 'Set password and continue to MFA' }).click();
  await page.getByRole('heading', { name: 'Connect your authenticator' }).waitFor();
  await page.getByRole('heading', { name: 'Manual setup key' }).waitFor();
  stage = 'interrupted enrollment';
  const pending = await connection.db.collection('accounts').findOne({ username });
  const originalCipher = pending.pendingMfaSecretCipher;
  await client.close(); client = undefined;
  await stopServer(); await startServer();
  await launch(); await signIn();
  await page.getByRole('heading', { name: 'Manual setup key' }).waitFor();
  const resumed = await connection.db.collection('accounts').findOne({ username });
  assert.deepEqual(resumed.pendingMfaSecretCipher, originalCipher);
  await page.getByLabel('Authenticator code', { exact: true }).fill(await totp());
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('heading', { name: 'Save your backup codes' }).waitFor();
  // Synthetic factor is held only in this test process, never logged or captured.
  savedBackupCode = await page.locator('.staff-backup-codes code').first().textContent();
  assert.equal(await page.getByRole('button', { name: 'I saved my codes — open workspace' }).isDisabled(), true);
  stage = 'interrupted backup acknowledgement';
  await client.close(); client = undefined;
  await stopServer(); await startServer();
  await launch(); await signIn();
  await page.getByRole('heading', { name: 'Enter your authenticator code' }).waitFor();
  await page.getByLabel('Authenticator code', { exact: true }).fill(await totp());
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('heading', { name: 'Save your backup codes' }).waitFor();
  assert.equal(await page.locator('.staff-backup-codes').count(), 0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'Staff workspace', exact: true }).waitFor();
  stage = 'workspace and keyboard';
  await dimensions(1080, 800);
  await page.screenshot({ path: join(evidence, `${packaged ? 'packaged-' : ''}workspace-desktop.png`) });
  stage = 'idle warning and server expiry';
  clockOffset = 9 * 60000 + 10000;
  await page.getByRole('heading', { name: 'Your session is about to expire' }).waitFor({ timeout: 25000 });
  await page.getByRole('button', { name: 'Continue session', exact: true }).click();
  await page.getByRole('heading', { name: 'Your session is about to expire' }).waitFor({ state: 'hidden' });
  clockOffset += 10 * 60000;
  await page.getByRole('heading', { name: 'Sign in to Cedar Staff' }).waitFor({ timeout: 25000 });
  assert.equal(await page.getByRole('heading', { name: 'Staff workspace', exact: true }).count(), 0);
  clockOffset = 0;
  await signIn();
  await page.getByRole('heading', { name: 'Enter your authenticator code' }).waitFor();
  await page.getByRole('button', { name: 'Use one of my backup codes' }).click();
  await page.getByLabel('Single-use backup code', { exact: true }).fill(savedBackupCode);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  savedBackupCode = undefined;
  await page.getByRole('heading', { name: 'Staff workspace', exact: true }).waitFor();
  stage = 'workspace and keyboard';
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
  await dimensions(360, 800);
  await page.getByRole('heading', { name: 'Staff workspace', exact: true }).focus();
  await page.screenshot({ path: join(evidence, `${packaged ? 'packaged-' : ''}workspace-narrow.png`), fullPage: true });
  const tokenIsolation = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, node: typeof window.process }));
  assert.deepEqual(tokenIsolation, { local: 0, session: 0, node: 'undefined' });
  assert.equal(externalRequests.length, 0);
  stage = 'server unavailable';
  await stopServer();
  await page.getByRole('heading', { name: 'Local staff server unavailable' }).waitFor({ timeout: 25000 });
  assert.equal(await page.getByRole('heading', { name: 'Staff workspace', exact: true }).count(), 0);
  await page.screenshot({ path: join(evidence, `${packaged ? 'packaged-' : ''}unavailable.png`) });
  await startServer();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in to Cedar Staff' }).waitFor();
  assert.equal(await connection.db.collection('accounts').countDocuments({}), 1);
  assert.equal((await connection.db.collection('installation_state').findOne({ _id: 'first-admin' })).status, 'completed');
  assert.equal(errors.length, 0, 'Renderer or Electron security warnings were detected.');
  console.log(`PASS: ${packaged ? 'packaged Windows executable' : 'Electron development executable'}: local setup, interrupted MFA/ack recovery, protected workspace, idle warning/Continue/server expiry, backup-code sign-in, keyboard, narrow wrapping, isolated tokens, zero renderer internet requests, unavailable-server/retry, and zero runtime/security errors.`);
} catch {
  console.error(`FAIL: Electron verification at '${stage}'. No secret-bearing screenshot or error payload was saved.`);
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
  await stopServer();
  if (connection) {
    assertIsolatedTestTarget(connection);
    for (const name of STAFF_COLLECTIONS) await connection.db.collection(name).deleteMany({});
    await connection.client.close();
  }
  vault?.destroy();
}
