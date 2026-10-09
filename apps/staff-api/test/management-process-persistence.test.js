import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  createSecurityFixture,
  syntheticProfile,
  syntheticPassword,
} from "./helpers/security-fixture.js";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";

let fixture;
let child;
before(async () => {
  fixture = await createSecurityFixture();
});
beforeEach(async () => {
  await child?.stop();
  child = undefined;
  await fixture.reset();
});
after(async () => {
  await child?.stop();
  await fixture?.close();
});
function ok(result) {
  assert.equal(result.status, 200);
  return result.body;
}
async function login(person) {
  const password = ok(
    await child.request("/auth/login", {
      body: { username: person.username, password: person.password },
    }),
  );
  return password.token
    ? password
    : ok(
        await child.request("/mfa/complete", {
          body: {
            challenge: password.challenge,
            code: await fixture.totp(person.secret),
          },
        }),
      );
}

test("owned API process restart preserves managed profiles, single-use activation, revocation and bootstrap isolation", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  child = await startIsolatedApiProcess();
  const manager = await login(actor);
  const profile = syntheticProfile({
    qualification: {
      type: "university",
      level: "Bachelor",
      title: "Synthetic administration",
      institution: "Synthetic institution",
    },
  });
  const created = ok(
    await child.request("/staff", {
      token: manager.token,
      body: {
        username: "synthetic.process.staff",
        roles: ["Clinic Receptionist"],
        profile,
      },
    }),
  );
  assert.equal(
    await fixture.db.collection("installation_state").countDocuments({}),
    0,
  );
  await child.stop();
  child = await startIsolatedApiProcess();
  const summary = ok(
    await child.request("/staff", { token: manager.token }),
  ).staff;
  assert.equal(
    summary.filter((entry) => entry.id === created.account.id).length,
    1,
  );
  const setup = {
    username: created.account.username,
    code: created.setupCode,
    password: syntheticPassword(),
  };
  const employee = ok(await child.request("/account/setup", { body: setup }));
  assert.ok(employee.token);
  await child.stop();
  child = await startIsolatedApiProcess();
  assert.equal(
    (await child.request("/account/setup", { body: setup })).status,
    401,
  );
  const current = ok(
    await child.request(
      `/staff/${encodeURIComponent(created.account.id)}/profile`,
      { token: manager.token },
    ),
  );
  const disabled = ok(
    await child.request(
      `/staff/${encodeURIComponent(created.account.id)}/status`,
      {
        token: manager.token,
        body: { expectedVersion: current.account.version, enabled: false },
      },
    ),
  );
  await child.stop();
  child = await startIsolatedApiProcess();
  assert.equal(
    (await child.request("/workspace", { token: employee.token })).status,
    401,
  );
  const enabled = ok(
    await child.request(
      `/staff/${encodeURIComponent(created.account.id)}/status`,
      {
        token: manager.token,
        body: { expectedVersion: disabled.account.version, enabled: true },
      },
    ),
  );
  assert.equal(enabled.account.status, "active");
  assert.equal(
    (await child.request("/workspace", { token: employee.token })).status,
    401,
  );
  assert.equal(
    await fixture.db.collection("installation_state").countDocuments({}),
    0,
  );
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 2);
});
