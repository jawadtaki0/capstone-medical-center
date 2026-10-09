import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  createSecurityFixture,
  STAFF_COLLECTIONS,
  digest,
} from "./helpers/security-fixture.js";
import { requiresMfa, ROLES } from "../src/permissions.js";
import { contactStatus } from "../src/contact-status.js";
import { syntheticProfile } from "./helpers/security-fixture.js";

describe(
  "guarded TEST email ownership and deliberate release, no real delivery",
  { concurrency: false },
  () => {
    let fixture, messages;
    const mock = {
      mode: "test",
      provider: "gmail",
      async configuration() {
        return { allowance: 20, approvalId: "synthetic-ownership" };
      },
      async send(message) {
        messages.push(message);
      },
    };
    before(async () => {
      fixture = await createSecurityFixture({
        contactDelivery: { email: mock },
      });
    });
    beforeEach(async () => {
      messages = [];
      await fixture.reset();
    });
    after(async () => {
      try {
        await fixture.reset();
      } finally {
        await fixture.close();
      }
    });
    const post = (path, actor, body) =>
      fixture.request(path, { method: "POST", token: actor?.token, body });
    const ok = (result) => {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    const denied = (result, code, status = 409) => {
      assert.equal(result.status, status, JSON.stringify(result.body));
      assert.equal(result.body.error.code, code);
    };
    const profile = (actor) =>
      fixture.db.collection("staff_profiles").findOne({ accountId: actor.id });
    async function login(actor) {
      fixture.advance(30000);
      const password = ok(
        await post("/auth/login", null, {
          username: actor.username,
          password: actor.password,
        }),
      );
      return password.token
        ? password
        : ok(
            await post("/mfa/complete", null, {
              challenge: password.challenge,
              code: await fixture.totp(actor.secret),
            }),
          );
    }
    async function person(roles = ["Clinic Receptionist"]) {
      const actor = await fixture.account({ roles, mfa: requiresMfa(roles) });
      return { ...actor, ...(await login(actor)) };
    }
    async function proof(actor, email, override = {}) {
      const saved = await profile(actor);
      await fixture.db.collection("staff_profiles").updateOne(
        { _id: saved._id },
        {
          $set: {
            email,
            emailVerified: true,
            emailVerification: {
              verifiedAt: fixture.clock(),
              method: "email_code",
              provider: "gmail",
              mode: "live",
              valueDigest: fixture.vault.contactDigest(email),
              ...override,
            },
          },
        },
      );
    }
    async function fingerprints() {
      return Object.fromEntries(
        await Promise.all(
          STAFF_COLLECTIONS.map(async (name) => [
            name,
            digest(
              JSON.stringify(
                await fixture.db
                  .collection(name)
                  .find()
                  .sort({ _id: 1 })
                  .toArray(),
              ),
            ),
          ]),
        ),
      );
    }
    async function begin(actor, email) {
      const result = ok(
        await post("/contacts/identity/start", actor, {
          type: "email",
          destination: email,
          password: actor.password,
          expectedRevision: (await profile(actor)).revision ?? 0,
        }),
      );
      if (result.kind === "contact_identity") {
        fixture.advance(30000);
        ok(
          await post("/contacts/identity/complete", actor, {
            type: "email",
            challenge: result.challenge,
            method: "totp",
            code: await fixture.totp(actor.secret),
          }),
        );
      }
      return messages.at(-1).code;
    }
    const complete = (actor, code) =>
      post("/contacts/complete", actor, { type: "email", code });
    async function status(actor, target, enabled) {
      const account = await fixture.db
        .collection("accounts")
        .findOne({ _id: target.id });
      return post(`/staff/${encodeURIComponent(target.id)}/status`, actor, {
        expectedVersion: account.version,
        enabled,
      });
    }
    async function releaseInput(target) {
      const account = await fixture.db
        .collection("accounts")
        .findOne({ _id: target.id });
      return {
        expectedVersion: account.version,
        expectedRevision: (await profile(target)).revision ?? 0,
        confirmed: true,
      };
    }
    const release = (actor, target, input) =>
      post(
        `/staff/${encodeURIComponent(target.id)}/email/release`,
        actor,
        input,
      );

    test("all six and mixed roles reject another verified owner, case/outer-space variants, with absolutely no state or send changes", async () => {
      const owner = await person();
      await proof(owner, "reserved@example.com.lb");
      for (const roles of [
        ...ROLES.map((role) => [role]),
        ["Admin", "System Admin"],
      ]) {
        const actor = await person(roles);
        const before = await fingerprints(),
          count = messages.length;
        denied(
          await post("/contacts/identity/start", actor, {
            type: "email",
            destination: "  RESERVED@EXAMPLE.COM.LB ",
            password: "wrong synthetic password",
            expectedRevision: 0,
          }),
          "contact_email_in_use",
        );
        assert.deepEqual(await fingerprints(), before);
        assert.equal(messages.length, count);
      }
      // No unauthenticated availability surface exists.
      assert.notEqual(
        (
          await post("/contacts/identity/start", null, {
            type: "email",
            destination: "reserved@example.com.lb",
          })
        ).status,
        200,
      );
    });

    test("unverified, invalid-proof and legacy-boolean-only addresses do not reserve; own unverified email still needs possession", async () => {
      for (const [index, overrides] of [
        { valueDigest: "wrong" },
        { verifiedAt: "invalid" },
        { provider: "unknown" },
        { releasedAt: fixture.clock() },
      ].entries()) {
        const owner = await person(),
          actor = await person();
        const email = `unreserved-${index}@example.org`;
        await proof(owner, email, overrides);
        const code = await begin(actor, email);
        assert.notEqual((await profile(actor)).email, email);
        ok(await complete(actor, code));
      }
      const owner = await person(),
        actor = await person();
      await fixture.db
        .collection("staff_profiles")
        .updateOne(
          { accountId: owner.id },
          { $set: { email: "legacy@example.edu", emailVerified: true } },
        );
      await begin(actor, "legacy@example.edu");
      const own = await person(),
        email = (await profile(own)).email;
      const code = await begin(own, email);
      assert.equal(
        contactStatus(await profile(own), fixture.vault).email,
        "unverified",
      );
      denied(
        await complete(own, "incorrect"),
        "contact_verification_failed",
        401,
      );
      ok(await complete(own, code));
      assert.equal(
        contactStatus(await profile(own), fixture.vault).email,
        "test_only",
      );
    });

    test("concurrent completions have one owner; late conflict never changes saved contact or consumes the rejected request", async () => {
      const actors = [await person(), await person()];
      const originals = await Promise.all(actors.map(profile));
      const codes = [];
      for (const actor of actors)
        codes.push(await begin(actor, "race@example.com"));
      const results = await Promise.all(
        actors.map((actor, index) => complete(actor, codes[index])),
      );
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 409],
      );
      const loser = results.findIndex((result) => result.status === 409);
      assert.equal(
        results[loser].body.error.message,
        "This email is used by another account",
      );
      assert.deepEqual(await profile(actors[loser]), originals[loser]);
      assert.equal(
        (
          await fixture.db
            .collection("contact_requests")
            .findOne({ accountId: actors[loser].id })
        ).state,
        "pending",
      );
      assert.equal(messages.length, 2);
    });

    test("disabled owners reserve across reactivation until another Admin explicitly releases; historical proof never revives", async () => {
      const admin = await person(["Admin"]),
        owner = await person(),
        claimant = await person();
      await proof(owner, "retained@example.com");
      ok(await status(admin, owner, false));
      denied(
        await post("/contacts/identity/start", claimant, {
          type: "email",
          destination: "retained@example.com",
          password: claimant.password,
          expectedRevision: 0,
        }),
        "contact_email_in_use",
      );
      ok(await status(admin, owner, true));
      assert.equal(
        contactStatus(await profile(owner), fixture.vault).email,
        "verified",
      );
      ok(await status(admin, owner, false));
      const input = await releaseInput(owner),
        saved = await profile(owner);
      await fixture.db.collection("contact_requests").insertOne({
        _id: "synthetic-release-pending",
        accountId: claimant.id,
        type: "email",
        destination: saved.email,
        generation: 1,
        state: "pending",
        codeHash: "synthetic",
        challengeHash: "synthetic",
      });
      const historicalRequest = {
        _id: "synthetic-consumed-history",
        accountId: owner.id,
        type: "email",
        state: "consumed",
        consumedAt: fixture.clock(),
        generation: "synthetic",
      };
      await fixture.db
        .collection("contact_requests")
        .insertOne(historicalRequest);
      ok(await release(admin, owner, input));
      assert.deepEqual(
        await fixture.db
          .collection("contact_requests")
          .findOne({ _id: historicalRequest._id }),
        historicalRequest,
      );
      const released = await profile(owner);
      assert.equal(released.email, saved.email);
      assert.equal(
        released.emailVerification.valueDigest,
        saved.emailVerification.valueDigest,
      );
      assert.equal(released.emailVerification.releasedBy, admin.id);
      assert.equal(contactStatus(released, fixture.vault).email, "released");
      assert.equal(
        (
          await fixture.db
            .collection("contact_requests")
            .findOne({ _id: "synthetic-release-pending" })
        ).state,
        "cancelled",
      );
      const before = await fingerprints();
      assert.equal(
        ok(await release(admin, owner, input)).alreadyReleased,
        true,
      );
      const repeated = await fingerprints();
      delete before.staff_management_state;
      delete repeated.staff_management_state;
      assert.deepEqual(repeated, before); // Only the shared serialization anchor advances.
      await fixture.restart({ reconnect: true });
      ok(await status(admin, owner, true));
      Object.assign(owner, await login(owner));
      assert.equal(
        contactStatus(await profile(owner), fixture.vault).email,
        "released",
      );
      const code = await begin(claimant, saved.email);
      ok(await complete(claimant, code));
      denied(
        await post("/contacts/identity/start", owner, {
          type: "email",
          destination: saved.email,
          password: owner.password,
          expectedRevision: released.revision,
        }),
        "contact_email_in_use",
      );
      const events = await fixture.db
        .collection("security_events")
        .find({ action: "staff_email_released" })
        .toArray();
      assert.equal(events.length, 1);
      assert.equal(events[0].actorId, admin.id);
      assert.equal(events[0].targetAccountId, owner.id);
      assert.equal(JSON.stringify(events).includes(saved.email), false);
    });

    test("release requires Admin, another disabled account, confirmation, current revisions and actual recent factors", async () => {
      const admin = await person(["Admin"]),
        system = await person(["System Admin", "Clinic Admin"]),
        owner = await person();
      await proof(owner, "permission@example.org");
      const activeInput = await releaseInput(owner);
      denied(
        await release(admin, owner, activeInput),
        "contact_release_unavailable",
      );
      ok(await status(admin, owner, false));
      const input = await releaseInput(owner),
        initial = await profile(owner);
      denied(await release(system, owner, input), "permission_denied", 403);
      denied(
        await release(admin, admin, await releaseInput(admin)),
        "permission_denied",
        403,
      );
      denied(
        await release(admin, owner, { ...input, confirmed: false }),
        "invalid_input",
        400,
      );
      denied(
        await release(admin, owner, { ...input, expectedRevision: 999 }),
        "stale_record",
      );
      fixture.advance(5 * 60000);
      denied(await release(admin, owner, input), "verification_required", 403);
      assert.deepEqual(await profile(owner), initial);
      Object.assign(admin, await login(admin));
      ok(await release(admin, owner, input));
    });

    test("release versus reactivation serializes: either release wins and stays released, or enabled account cannot be released", async () => {
      const admin = await person(["Admin"]),
        owner = await person();
      await proof(owner, "reactivation-race@example.com");
      ok(await status(admin, owner, false));
      const input = await releaseInput(owner);
      const [released, activated] = await Promise.all([
        release(admin, owner, input),
        status(admin, owner, true),
      ]);
      ok(activated);
      assert.ok([200, 409].includes(released.status));
      assert.equal(
        contactStatus(await profile(owner), fixture.vault).email,
        released.status === 200 ? "released" : "verified",
      );
    });

    test("release versus pending verification cancels old challenges; rollback and conflicts fail closed", async () => {
      const admin = await person(["Admin"]),
        owner = await person(),
        claimant = await person();
      const code = await begin(claimant, "release-race@example.com");
      await proof(owner, "release-race@example.com");
      ok(await status(admin, owner, false));
      const [released, verified] = await Promise.all([
        release(admin, owner, await releaseInput(owner)),
        complete(claimant, code),
      ]);
      ok(released);
      assert.ok([401, 409].includes(verified.status));
      assert.notEqual(
        (await profile(claimant)).email,
        "release-race@example.com",
      );
      const fresh = await begin(claimant, "release-race@example.com");
      ok(await complete(claimant, fresh));
      // Another owned fixture forces audit failure; release must roll back proof.
      const second = await person();
      await proof(second, "rollback@example.org");
      ok(await status(admin, second, false));
      const initial = await profile(second),
        input = await releaseInput(second);
      await fixture.restart({ failAudit: true });
      assert.equal((await release(admin, second, input)).status, 503);
      assert.deepEqual(await profile(second), initial);
    });

    test("unexpected duplicate verified proofs are reported, not repaired or arbitrarily assigned", async () => {
      const owners = [await person(), await person()],
        claimant = await person();
      for (const owner of owners) await proof(owner, "conflict@example.com");
      const before = await fingerprints();
      denied(
        await post("/contacts/identity/start", claimant, {
          type: "email",
          destination: "conflict@example.com",
          password: claimant.password,
          expectedRevision: 0,
        }),
        "contact_ownership_conflict",
      );
      assert.deepEqual(await fingerprints(), before);
      assert.equal(messages.length, 0);
    });

    test("released historical contacts never receive change notifications and legacy invalid input does not block unrelated edits", async () => {
      const admin = await person(["Admin"]),
        owner = await person();
      await proof(owner, "historical@example.org");
      ok(await status(admin, owner, false));
      ok(await release(admin, owner, await releaseInput(owner)));
      ok(await status(admin, owner, true));
      Object.assign(owner, await login(owner));
      const code = await begin(owner, "new-current@example.com.lb");
      ok(await complete(owner, code));
      assert.equal(messages.length, 1);
      assert.equal(messages[0].notification, undefined);
      assert.equal(
        contactStatus(await profile(owner), fixture.vault).email,
        "test_only",
      );
      const legacy = await person();
      await fixture.db.collection("staff_profiles").updateOne(
        { accountId: legacy.id },
        {
          $set: {
            email: "legacy invalid email",
            phone: " 000 synthetic placeholder ",
          },
        },
      );
      const before = await profile(legacy);
      const detail = await fixture.request(
        `/staff/${encodeURIComponent(legacy.id)}/profile`,
        { token: admin.token },
      );
      ok(detail);
      ok(
        await post(`/staff/${encodeURIComponent(legacy.id)}/profile`, admin, {
          expectedRevision: before.revision ?? 0,
          profile: { address: "New legacy fixture address" },
        }),
      );
      const after = await profile(legacy);
      assert.equal(after.email, before.email);
      assert.equal(after.phone, before.phone);
      assert.equal(after.address, "New legacy fixture address");
      denied(
        await post(`/staff/${encodeURIComponent(legacy.id)}/profile`, admin, {
          expectedRevision: after.revision,
          profile: { address: "Forbidden mixed patch", phone: "+9613123456" },
        }),
        "contact_change_not_ready",
      );
      assert.deepEqual(await profile(legacy), after);
      const initial = ok(
        await post("/staff", admin, {
          username: "synthetic.international",
          roles: ["Clinic Receptionist"],
          profile: syntheticProfile({
            phone: "+1 (213) 373-4253",
            qualification: {
              type: "university",
              level: "Bachelor",
              title: "Synthetic qualification",
              institution: "Synthetic university",
            },
          }),
        }),
      );
      const stored = await fixture.db
        .collection("staff_profiles")
        .findOne({ accountId: initial.account.id });
      assert.equal(stored.phone, "+12133734253");
      assert.equal(stored.phoneCountry, "US");
      const international = ok(
        await fixture.request(
          `/staff/${encodeURIComponent(initial.account.id)}/profile`,
          { token: admin.token },
        ),
      );
      assert.equal(international.profile.phoneCountry, "US");
      denied(
        await post(
          `/staff/${encodeURIComponent(initial.account.id)}/profile`,
          admin,
          {
            expectedRevision: 0,
            profile: { phoneCountry: "LB", address: "Must not save" },
          },
        ),
        "invalid_input",
        400,
      );
      assert.deepEqual(
        await fixture.db
          .collection("staff_profiles")
          .findOne({ accountId: initial.account.id }),
        stored,
      );
    });
  },
);
