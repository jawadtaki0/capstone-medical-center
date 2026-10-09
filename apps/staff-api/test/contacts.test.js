import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  CONTACT_POLICY,
  beirutMonth,
  createContactService,
} from "../src/contacts.js";
import { contactStatus } from "../src/contact-status.js";
import {
  createGmailDelivery,
  enableStaffSelfService,
  safeDeliveryError,
} from "../src/contact-delivery.js";
import { requiresMfa, ROLES } from "../src/permissions.js";
import {
  createSecurityFixture,
  STAFF_COLLECTIONS,
  digest,
} from "./helpers/security-fixture.js";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";

test("contact policy and Beirut monthly boundaries are explicit", () => {
  assert.equal(CONTACT_POLICY.monthly, 20);
  assert.equal(CONTACT_POLICY.maxFailures, 5);
  assert.equal(CONTACT_POLICY.codeMs, 600000);
  assert.equal(CONTACT_POLICY.resendMs, 60000);
  assert.equal(beirutMonth(new Date("2026-09-30T22:00:00Z")), "2026-10");
  assert.throws(
    () =>
      createContactService({
        db: { databaseName: "capstone_staff_dev" },
        client: { options: { hosts: [{ host: "127.0.0.1", port: 27018 }] } },
        delivery: { email: { mode: "test" } },
      }),
    /restricted/,
  );
});

test("legacy booleans and TEST proofs never claim real contact verification", () => {
  const vault = { contactDigest: (value) => `test:${value}` };
  const profile = { email: "synthetic@example.invalid", emailVerified: true };
  assert.equal(contactStatus(profile, vault).email, "unverified");
  profile.emailVerification = {
    verifiedAt: new Date(),
    method: "email_code",
    provider: "gmail",
    mode: "test",
    valueDigest: vault.contactDigest(profile.email),
  };
  assert.equal(contactStatus(profile, vault).email, "test_only");
  profile.emailVerification.mode = "live";
  assert.equal(contactStatus(profile, vault).email, "verified");
  profile.email = "other@example.invalid";
  assert.equal(contactStatus(profile, vault).email, "unverified");
  assert.equal(contactStatus(profile, vault).phone, "unverified");
});

describe(
  "guarded synthetic contact verification, never outbound mail",
  { concurrency: false },
  () => {
    let fixture, enabled, fail, allowance, messages;
    const mock = (provider) => ({
      mode: "test",
      provider,
      async configuration(destination) {
        if (!enabled)
          throw safeDeliveryError({ code: "contact_delivery_disabled" });
        // Exercise the actual self-service policy using only synthetic settings.
        // Mode remains TEST; no transport, protected config or live ledger access.
        if (provider === "gmail")
          await createGmailDelivery({
            load: async () => ({
              version: 2,
              deliveryScope: "staff_self_service",
              provider: "gmail",
              sender: "synthetic.sender@gmail.com",
              appPassword: "SyntheticOnly123",
              enabled: true,
              allowance,
              approvalId: "11111111-1111-1111-1111-111111111111",
            }),
            transport() {
              throw new Error("TEST must never construct SMTP");
            },
          }).configuration(destination);
        return {
          approvalId: "11111111-1111-1111-1111-111111111111",
          allowance,
        };
      },
      async send(message) {
        messages.push({ ...message, provider });
        if (fail) throw new Error("Synthetic network unavailable");
      },
    });
    before(async () => {
      fixture = await createSecurityFixture({
        contactDelivery: { email: mock("gmail"), phone: mock("whatsapp") },
      });
    });
    beforeEach(async () => {
      enabled = true;
      fail = false;
      allowance = 20;
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
    const post = (path, token, body) =>
      fixture.request(path, { method: "POST", token, body });
    const ok = (response) => {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    };
    const denied = (response, code, status = 401) => {
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, code);
    };
    const profile = (person) =>
      fixture.db.collection("staff_profiles").findOne({ accountId: person.id });
    async function login(person) {
      const result = ok(
        await post("/auth/login", null, {
          username: person.username,
          password: person.password,
        }),
      );
      return result.token
        ? result
        : ok(
            await post("/mfa/complete", null, {
              challenge: result.challenge,
              code: await fixture.totp(person.secret),
            }),
          );
    }
    async function person(roles = ["Clinic Receptionist"]) {
      const account = await fixture.account({ roles, mfa: requiresMfa(roles) });
      return { ...account, ...(await login(account)) };
    }
    test("assigned receptionists without an enrolled MFA version can verify contact without a guessed account backfill", async () => {
      for (const roles of [
        ["Clinic Receptionist"],
        ["Lab Receptionist"],
        ["Clinic Receptionist", "Lab Receptionist"],
      ]) {
        const account = await person(roles);
        await fixture.db.collection("accounts").updateOne(
          { _id: account.id },
          {
            $set: {
              mfa: roles.includes("Clinic Receptionist")
                ? null
                : { enabled: false },
            },
          },
        );
        const before = await fixture.db
          .collection("accounts")
          .findOne({ _id: account.id });
        const beforeProfile = await profile(account);
        const sent = ok(
          await post("/contacts/identity/start", account.token, {
            type: "email",
            destination: `${account.username}@example.invalid`,
            password: account.password,
            expectedRevision: 0,
          }),
        );
        assert.equal(sent.sent, true);
        assert.equal((await profile(account)).email, beforeProfile.email);
        const complete = ok(
          await post("/contacts/complete", account.token, {
            type: "email",
            code: messages.at(-1).code,
          }),
        );
        assert.equal(complete.testOnly, true);
        assert.equal(
          (await profile(account)).email,
          `${account.username}@example.invalid`,
        );
        assert.deepEqual(
          await fixture.db.collection("accounts").findOne({ _id: account.id }),
          before,
        );
      }
    });
    async function begin(
      account,
      type = "email",
      destination = "replacement@example.invalid",
    ) {
      const result = ok(
        await post("/contacts/identity/start", account.token, {
          type,
          destination,
          password: account.password,
          expectedRevision: (await profile(account)).revision ?? 0,
        }),
      );
      if (result.kind === "contact_identity") {
        fixture.advance(30000);
        return ok(
          await post("/contacts/identity/complete", account.token, {
            type,
            challenge: result.challenge,
            method: "totp",
            code: await fixture.totp(account.secret),
          }),
        );
      }
      return result;
    }
    const complete = (account, code = messages.at(-1)?.code, type = "email") =>
      post("/contacts/complete", account.token, { type, code });

    async function syntheticVerifiedProof(account) {
      const saved = await profile(account);
      await fixture.db.collection("staff_profiles").updateOne(
        { _id: saved._id },
        {
          $set: {
            emailVerification: {
              verifiedAt: fixture.clock(),
              method: "email_code",
              provider: "gmail",
              mode: "live",
              valueDigest: fixture.vault.contactDigest(saved.email),
            },
          },
        },
      );
      return saved;
    }
    async function stateFingerprints() {
      const state = {};
      for (const collection of STAFF_COLLECTIONS)
        state[collection] = digest(
          JSON.stringify(
            await fixture.db
              .collection(collection)
              .find()
              .sort({ _id: 1 })
              .toArray(),
          ),
        );
      return state;
    }

    test("same verified normalized email rejects for every role without altering pending requests, factors, profiles, counters, budgets or messages", async () => {
      for (const roles of [
        ...ROLES.map((role) => [role]),
        ["Admin", "System Admin"],
      ]) {
        const account = await person(roles);
        // Prime meaningful nonempty state, including an existing pending code,
        // independent failure count and outbound budget; all TEST/mocked only.
        denied(
          await post("/contacts/identity/start", account.token, {
            type: "email",
            destination: "wrong@example.invalid",
            password: "Wrong synthetic password",
            expectedRevision: 0,
          }),
          "contact_verification_failed",
        );
        await begin(
          account,
          "email",
          `pending-${messages.length}@example.invalid`,
        );
        const saved = await syntheticVerifiedProof(account);
        const before = await stateFingerprints(),
          messageFingerprint = digest(JSON.stringify(messages));
        enabled = false; // The no-op must precede even provider configuration.
        for (const destination of [
          saved.email,
          `  ${saved.email.toUpperCase()}  `,
          `\t${saved.email}\n`,
        ]) {
          const response = await post(
            "/contacts/identity/start",
            account.token,
            {
              type: "email",
              destination,
              password: "Wrong synthetic password",
              expectedRevision: 0,
            },
          );
          denied(response, "contact_email_already_verified", 409);
          assert.equal(
            response.body.error.message,
            "This email is already verified. Enter a different address to change it.",
          );
          assert.deepEqual(await stateFingerprints(), before);
          assert.equal(digest(JSON.stringify(messages)), messageFingerprint);
        }
        enabled = true;
      }
    });

    test("matching unverified email still requires possession proof and a legacy boolean alone cannot reject it", async () => {
      for (const legacy of [undefined, true, false]) {
        const account = await person(),
          saved = await profile(account);
        if (legacy !== undefined)
          await fixture.db
            .collection("staff_profiles")
            .updateOne({ _id: saved._id }, { $set: { emailVerified: legacy } });
        const beforeMessages = messages.length;
        await begin(account, "email", ` ${saved.email.toUpperCase()} `);
        assert.equal((await profile(account)).emailVerification, undefined);
        assert.equal((await profile(account)).email, saved.email);
        const result = ok(await complete(account));
        assert.equal(result.notificationWarning, false);
        assert.equal(result.testOnly, true);
        assert.equal(
          contactStatus(await profile(account), fixture.vault).email,
          "test_only",
        );
        assert.equal((await profile(account)).email, saved.email);
        assert.equal(messages.length, beforeMessages + 1);
        assert.equal(messages.at(-1).notification, undefined);
      }
    });

    test("older same-address pending request completes without contact-changed notification despite verified old proof and case differences", async () => {
      const account = await person(),
        initial = await profile(account);
      await fixture.db
        .collection("staff_profiles")
        .updateOne(
          { _id: initial._id },
          { $set: { email: initial.email.toUpperCase() } },
        );
      await begin(account, "email", ` ${initial.email} `);
      // Model a pre-correction pending request whose old value already had live
      // proof. Do not change its revision; this is an owned TEST fixture only.
      await syntheticVerifiedProof(account);
      const budgetsBefore = await fixture.db
        .collection("contact_delivery_budgets")
        .find()
        .sort({ _id: 1 })
        .toArray();
      const outcome = ok(await complete(account));
      assert.equal(outcome.notificationWarning, false);
      assert.equal((await profile(account)).email, initial.email);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].notification, undefined);
      assert.deepEqual(
        await fixture.db
          .collection("contact_delivery_budgets")
          .find()
          .sort({ _id: 1 })
          .toArray(),
        budgetsBefore,
      );
      assert.equal(
        await fixture.db
          .collection("security_events")
          .countDocuments({ action: "contact_old_notification" }),
        0,
      );
    });

    test("different normalized email keeps existing verified-old notification and shared budget behavior", async () => {
      const account = await person(),
        saved = await syntheticVerifiedProof(account);
      await begin(account, "email", "NEW@example.invalid");
      const outcome = ok(await complete(account));
      assert.equal(outcome.notificationWarning, false);
      assert.equal((await profile(account)).email, "new@example.invalid");
      assert.equal(messages.length, 2);
      assert.equal(messages[0].destination, "new@example.invalid");
      assert.equal(messages[1].destination, saved.email);
      assert.equal(messages[1].notification, true);
      assert.equal(messages[1].code, undefined);
      assert.equal(
        (
          await fixture.db.collection("contact_delivery_budgets").findOne({
            _id: `month:test-gmail:${beirutMonth(fixture.clock())}`,
          })
        ).attempts,
        2,
      );
    });

    test("all six roles and mixed roles can use previously unlisted emails with actual factors and possession proof", async () => {
      for (const roles of [
        ...ROLES.map((role) => [role]),
        ["System Admin", "Clinic Receptionist"],
      ]) {
        const account = await person(roles),
          before = await profile(account);
        await begin(account, "email", `new-${messages.length}@example.invalid`);
        assert.equal((await profile(account)).email, before.email);
        const outcome = ok(await complete(account));
        assert.equal(outcome.verified, false);
        assert.equal(outcome.testOnly, true);
        const own = ok(
          await fixture.request("/profiles/me", { token: account.token }),
        );
        assert.equal(own.profile.contactStatus.email, "test_only");
        assert.equal(own.profile.emailVerification, undefined);
        assert.equal(own.profile.emailVerified, undefined);
        assert.equal(own.profile.contactStatus.phone, "unverified");
        denied(await complete(account), "contact_verification_failed");
      }
      assert.equal(messages.length, 7); // No notification to unverified legacy contacts.
      assert.equal(
        await fixture.db
          .collection("contact_delivery_budgets")
          .countDocuments({ _id: /^month:gmail:/ }),
        0,
      );
    });

    test("TEST phone simulation is explicitly not verification and cannot enable a live provider", async () => {
      const account = await person();
      await begin(account, "phone", "+96170000000");
      const result = ok(await complete(account, messages.at(-1).code, "phone"));
      assert.equal(result.testOnly, true);
      assert.equal(result.verified, false);
      assert.equal(
        contactStatus(await profile(account), fixture.vault).phone,
        "unverified",
      );
      assert.equal(
        ok(await fixture.request("/contacts/status", { token: account.token }))
          .phoneReady,
        false,
      );
    });

    test("wrong passwords and identity factors keep contact counters independent from login and other accounts", async () => {
      const account = await person(["Admin"]),
        other = await person();
      const priorThrottles = await fixture.db
        .collection("auth_throttles")
        .find()
        .toArray();
      for (let index = 0; index < 5; index++)
        denied(
          await post("/contacts/identity/start", account.token, {
            type: "email",
            destination: "new@example.invalid",
            password: "Wrong synthetic password",
            expectedRevision: 0,
          }),
          "contact_verification_failed",
        );
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "new@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_try_later",
        429,
      );
      assert.deepEqual(
        await fixture.db.collection("auth_throttles").find().toArray(),
        priorThrottles,
      );
      await begin(other);
      ok(await complete(other));
      fixture.advance(30000);
      await login(account); // Ordinary login is not locked by contact failures.
      assert.equal(messages.length, 1);
    });

    test("identity challenge replacement, wrong MFA and replay cannot reset contact penalties or extend sessions", async () => {
      const account = await person(["Admin"]);
      const original = await fixture.db
        .collection("staff_sessions")
        .findOne({ accountId: account.id });
      let first;
      for (let index = 0; index < 5; index++) {
        const challenge = ok(
          await post("/contacts/identity/start", account.token, {
            type: "email",
            destination: "new@example.invalid",
            password: account.password,
            expectedRevision: 0,
          }),
        ).challenge;
        first ??= challenge;
        denied(
          await post("/contacts/identity/complete", account.token, {
            type: "email",
            challenge,
            method: "totp",
            code: "not-a-code",
          }),
          "contact_verification_failed",
        );
      }
      denied(
        await post("/contacts/identity/complete", account.token, {
          type: "email",
          challenge: first,
          method: "totp",
          code: await fixture.totp(account.secret),
        }),
        "contact_try_later",
        429,
      );
      assert.equal(messages.length, 0);
      const session = await fixture.db
        .collection("staff_sessions")
        .findOne({ _id: original._id });
      for (const field of [
        "lastActivityAt",
        "absoluteExpiresAt",
        "passwordVerifiedAt",
        "mfaVerifiedAt",
      ])
        assert.deepEqual(session[field], original[field]);
    });

    test("cancel, replacement and resend supersede codes without extending expiry or clearing counters", async () => {
      const account = await person();
      await begin(account);
      const first = messages.at(-1).code;
      const request = await fixture.db
        .collection("contact_requests")
        .findOne({ accountId: account.id });
      assert.deepEqual(messages.at(-1).expiresAt, request.expiresAt);
      denied(
        await post("/contacts/resend", account.token, { type: "email" }),
        "contact_resend_wait",
        409,
      );
      fixture.advance(60000);
      ok(await post("/contacts/resend", account.token, { type: "email" }));
      const second = messages.at(-1).code;
      assert.deepEqual(messages.at(-1).expiresAt, request.expiresAt);
      assert.deepEqual(
        (
          await fixture.db
            .collection("contact_requests")
            .findOne({ accountId: account.id })
        ).expiresAt,
        request.expiresAt,
      );
      denied(await complete(account, first), "contact_verification_failed");
      ok(await post("/contacts/cancel", account.token, { type: "email" }));
      denied(await complete(account, second), "contact_verification_failed");
      await begin(account, "email", "other@example.invalid");
      denied(await complete(account, second), "contact_verification_failed");
      const counter = await fixture.db
        .collection("contact_counters")
        .findOne({ _id: `code:${account.id}:email` });
      assert.equal(counter.failures, 3);
      ok(await complete(account));
      assert.equal(messages.length, 3);
    });

    test("hourly/destination and two-resend limits persist after replacing and cancelling", async () => {
      const account = await person();
      await begin(account);
      fixture.advance(60000);
      ok(await post("/contacts/resend", account.token, { type: "email" }));
      fixture.advance(60000);
      ok(await post("/contacts/resend", account.token, { type: "email" }));
      fixture.advance(60000);
      denied(
        await post("/contacts/resend", account.token, { type: "email" }),
        "contact_resend_wait",
        409,
      );
      ok(await post("/contacts/cancel", account.token, { type: "email" }));
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "other@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_try_later",
        429,
      );
      const other = await person();
      denied(
        await post("/contacts/identity/start", other.token, {
          type: "email",
          destination: "replacement@example.invalid",
          password: other.password,
          expectedRevision: 0,
        }),
        "contact_try_later",
        429,
      );
      assert.equal(messages.length, 3);
    });

    test("daily ceiling persists beyond the hourly window", async () => {
      const account = await person();
      for (let index = 0; index < 10; index++) {
        if (index) {
          fixture.advance(61 * 60000);
          Object.assign(account, await login(account));
        }
        await begin(account, "email", `daily-${index}@example.invalid`);
        ok(await post("/contacts/cancel", account.token, { type: "email" }));
      }
      fixture.advance(61 * 60000);
      Object.assign(account, await login(account));
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "daily-next@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_try_later",
        429,
      );
      assert.equal(messages.length, 10);
    });

    test("20 attempts per provider/month includes delivery failures; mocks never reserve live budgets", async () => {
      fail = true;
      for (let index = 0; index < 20; index++) {
        const account = await person();
        denied(
          await post("/contacts/identity/start", account.token, {
            type: "email",
            destination: `monthly-${index}@example.invalid`,
            password: account.password,
            expectedRevision: 0,
          }),
          "contact_delivery_failed",
          502,
        );
      }
      const account = await person();
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "monthly-next@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_sending_limit",
        429,
      );
      assert.equal(messages.length, 20);
      assert.equal(
        await fixture.db
          .collection("contact_delivery_budgets")
          .countDocuments({ _id: /^month:gmail:/ }),
        0,
      );
      assert.equal(
        (
          await fixture.db.collection("contact_delivery_budgets").findOne({
            _id: `month:test-gmail:${beirutMonth(fixture.clock())}`,
          })
        ).attempts,
        20,
      );
    });

    test("smaller explicit allowance and failed configuration never overwrite saved contacts", async () => {
      const account = await person(),
        initial = await profile(account);
      enabled = false;
      const absent = await post("/contacts/identity/start", account.token, {
        type: "email",
        destination: "new@example.invalid",
        password: account.password,
        expectedRevision: 0,
      });
      assert.notEqual(absent.status, 200);
      assert.equal(absent.body.error.code, "contact_delivery_disabled");
      const status = ok(
        await fixture.request("/contacts/status", { token: account.token }),
      );
      assert.equal(status.deliveryStatus, "contact_delivery_disabled");
      assert.match(status.message, /disabled/);
      assert.equal(messages.length, 0);
      assert.equal(
        await fixture.db
          .collection("contact_delivery_budgets")
          .countDocuments(),
        0,
      );
      enabled = true;
      allowance = 1;
      fail = true;
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "new@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_delivery_failed",
        502,
      );
      assert.equal((await profile(account)).email, initial.email);
      fixture.advance(60000);
      denied(
        await post("/contacts/resend", account.token, { type: "email" }),
        "contact_sending_limit",
        429,
      );
      assert.equal(messages.length, 1);
    });

    test("concurrent unlisted destinations share the unchanged allowance with one reservation winner", async () => {
      allowance = 1;
      const accounts = [await person(), await person()];
      const originals = await Promise.all(accounts.map(profile));
      const results = await Promise.all(
        accounts.map((account, index) =>
          post("/contacts/identity/start", account.token, {
            type: "email",
            destination: `unlisted-concurrent-${index}@example.invalid`,
            password: account.password,
            expectedRevision: 0,
          }),
        ),
      );
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 429],
      );
      const loser = results.findIndex((result) => result.status === 429);
      assert.equal(results[loser].body.error.code, "contact_sending_limit");
      assert.match(results[loser].body.error.message, /allowance.*exhausted/);
      assert.equal(messages.length, 1);
      for (let index = 0; index < accounts.length; index++)
        assert.deepEqual(await profile(accounts[index]), originals[index]);
      assert.equal(
        await fixture.db.collection("contact_requests").countDocuments(),
        1,
      );
      assert.equal(
        (
          await fixture.db.collection("contact_delivery_budgets").findOne({
            _id: "approval:test-gmail:11111111-1111-1111-1111-111111111111",
          })
        ).attempts,
        1,
      );
    });

    test("scope activation cannot replenish an already used allowance or bypass its persisted budget", async () => {
      const legacy = {
        version: 1,
        provider: "gmail",
        sender: "synthetic.sender@gmail.com",
        appPassword: "SyntheticOnly123",
        enabled: true,
        allowance: 1,
        approvalId: "11111111-1111-1111-1111-111111111111",
        recipients: ["old@example.invalid"],
      };
      const upgraded = enableStaffSelfService(legacy);
      allowance = upgraded.allowance;
      // This mock's stable budget key represents the same existing approval.
      await fixture.db.collection("contact_delivery_budgets").insertOne({
        _id: "approval:test-gmail:11111111-1111-1111-1111-111111111111",
        attempts: 1,
      });
      const account = await person(),
        before = await profile(account);
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "unlisted-after-upgrade@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_sending_limit",
        429,
      );
      assert.equal(upgraded.approvalId, legacy.approvalId);
      assert.equal(messages.length, 0);
      assert.deepEqual(await profile(account), before);
      assert.equal(
        await fixture.db.collection("contact_requests").countDocuments(),
        0,
      );
      assert.equal(
        (
          await fixture.db.collection("contact_delivery_budgets").findOne({
            _id: "approval:test-gmail:11111111-1111-1111-1111-111111111111",
          })
        ).attempts,
        1,
      );
    });

    test("concurrent completion has one winner; stale profile edits and disabled accounts cannot install a contact", async () => {
      const account = await person();
      await begin(account);
      const code = messages.at(-1).code;
      const results = await Promise.all([
        complete(account, code),
        complete(account, code),
      ]);
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 401],
      );
      await begin(account, "email", "stale@example.invalid");
      ok(
        await post("/profiles/me/contact", account.token, {
          expectedRevision: 1,
          address: "Synthetic changed address",
        }),
      );
      denied(await complete(account), "contact_verification_failed");
      assert.equal(
        (await profile(account)).email,
        "replacement@example.invalid",
      );
      await begin(account, "email", "disabled@example.invalid");
      await fixture.db
        .collection("accounts")
        .updateOne(
          { _id: account.id },
          { $set: { status: "disabled" }, $inc: { version: 1 } },
        );
      assert.notEqual((await complete(account)).status, 200);
      assert.equal(
        (await profile(account)).email,
        "replacement@example.invalid",
      );
    });

    test("single-use backup identity factors are consumed transactionally, without refreshing manager proof", async () => {
      const account = await person(["Lab Admin"]);
      const pending = ok(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "new@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
      );
      const body = {
        type: "email",
        challenge: pending.challenge,
        method: "backup",
        code: account.backupCodes[0],
      };
      const outcomes = await Promise.all([
        post("/contacts/identity/complete", account.token, body),
        post("/contacts/identity/complete", account.token, body),
      ]);
      assert.deepEqual(
        outcomes.map((result) => result.status).sort(),
        [200, 401],
      );
      assert.equal(messages.length, 1);
      assert.ok(
        (await fixture.db.collection("accounts").findOne({ _id: account.id }))
          .mfa.backupCodes[0].usedAt instanceof Date,
      );
    });

    test("expired identity/code and background status do not keep an unattended session alive", async () => {
      const account = await person();
      await begin(account);
      const code = messages.at(-1).code;
      for (let index = 0; index < 9; index++) {
        fixture.advance(60000);
        ok(await fixture.request("/contacts/status", { token: account.token }));
      }
      fixture.advance(60000);
      assert.notEqual((await complete(account, code)).status, 200);
      assert.notEqual(
        (await fixture.request("/contacts/status", { token: account.token }))
          .status,
        200,
      );
      assert.equal((await profile(account)).emailVerification, undefined);
    });

    test("identity/code expiry is server checked even while a genuine interaction keeps a session valid", async () => {
      const admin = await person(["Admin"]);
      const started = ok(
        await post("/contacts/identity/start", admin.token, {
          type: "email",
          destination: "new@example.invalid",
          password: admin.password,
          expectedRevision: 0,
        }),
      );
      fixture.advance(5 * 60000);
      denied(
        await post("/contacts/identity/complete", admin.token, {
          type: "email",
          challenge: started.challenge,
          method: "totp",
          code: await fixture.totp(admin.secret),
        }),
        "contact_verification_failed",
      );
      const account = await person();
      await begin(account);
      fixture.advance(9 * 60000);
      ok(await post("/auth/activity", account.token, { kind: "interaction" }));
      fixture.advance(60000);
      denied(await complete(account), "contact_verification_failed");
      ok(await fixture.request("/workspace", { token: account.token }));
      assert.equal((await profile(account)).emailVerification, undefined);
    });

    test("five wrong possession codes persist across cancel/restart and do not block another employee", async () => {
      const account = await person(),
        other = await person();
      await begin(account);
      for (let index = 0; index < 5; index++)
        denied(
          await complete(account, "not-a-code"),
          "contact_verification_failed",
        );
      ok(await post("/contacts/cancel", account.token, { type: "email" }));
      await fixture.restart({ reconnect: true });
      denied(
        await post("/contacts/identity/start", account.token, {
          type: "email",
          destination: "other@example.invalid",
          password: account.password,
          expectedRevision: 0,
        }),
        "contact_try_later",
        429,
      );
      await begin(other, "email", "unrelated@example.invalid");
      ok(await complete(other));
      assert.equal((await profile(account)).emailVerification, undefined);
    });

    test("notifications to a previously verified old value consume the same ceiling; notification failure does not undo replacement", async () => {
      const account = await person(),
        saved = await profile(account);
      // Synthetic value-bound old proof in TEST only, not a claim of real delivery.
      await fixture.db.collection("staff_profiles").updateOne(
        { _id: saved._id },
        {
          $set: {
            emailVerification: {
              verifiedAt: fixture.clock(),
              method: "email_code",
              provider: "gmail",
              mode: "live",
              valueDigest: fixture.vault.contactDigest(saved.email),
            },
          },
        },
      );
      await begin(account);
      fail = true;
      const outcome = ok(await complete(account));
      assert.equal(outcome.notificationWarning, true);
      assert.equal(outcome.verified, false);
      assert.equal(
        (await profile(account)).email,
        "replacement@example.invalid",
      );
      assert.equal(messages.length, 2);
      assert.equal(messages[1].notification, true);
      assert.equal(messages[1].code, undefined);
      assert.equal(
        (
          await fixture.db.collection("contact_delivery_budgets").findOne({
            _id: `month:test-gmail:${beirutMonth(fixture.clock())}`,
          })
        ).attempts,
        2,
      );
    });

    test("email/code data are absent from security events and manager profile replacement stays forbidden", async () => {
      const admin = await person(["Admin"]),
        target = await person();
      await begin(target);
      const code = messages.at(-1).code;
      ok(await complete(target));
      const forbidden = await post(
        `/staff/${encodeURIComponent(target.id)}/profile`,
        admin.token,
        {
          expectedRevision: 1,
          profile: {
            email: "bypass@example.invalid",
            address: "Forbidden mixed address",
          },
        },
      );
      assert.notEqual(forbidden.status, 200);
      assert.notEqual(
        (await profile(target)).address,
        "Forbidden mixed address",
      );
      const logs = JSON.stringify(
        await fixture.db.collection("security_events").find().toArray(),
      );
      for (const sensitive of [
        code,
        target.password,
        "replacement@example.invalid",
        target.secret,
      ].filter(Boolean))
        assert.equal(logs.includes(sensitive), false);
      const request = await fixture.db
        .collection("contact_requests")
        .findOne({ accountId: target.id });
      assert.equal(request.codeHash, undefined);
      assert.equal(request.destination, undefined);
    });

    test("transaction failures rollback consumption; contact requests survive reconnect without fabricated verification", async () => {
      const account = await person();
      await begin(account);
      const code = messages.at(-1).code;
      await fixture.restart({ failAudit: true });
      assert.equal((await complete(account, code)).status, 503);
      assert.equal((await profile(account)).emailVerification, undefined);
      await fixture.restart({ reconnect: true });
      ok(await complete(account, code));
      assert.equal(
        contactStatus(await profile(account), fixture.vault).email,
        "test_only",
      );
      const stored = await fixture.db
        .collection("contact_requests")
        .findOne({ accountId: account.id });
      assert.equal(stored.deliveryMode, "test");
    });

    test("delivery-mode substitution and private verification-field injection are rejected", async () => {
      const account = await person();
      await begin(account);
      const code = messages.at(-1).code;
      await fixture.db
        .collection("contact_requests")
        .updateOne(
          { accountId: account.id },
          { $set: { deliveryMode: "live" } },
        );
      denied(await complete(account, code), "contact_verification_failed");
      assert.equal((await profile(account)).emailVerification, undefined);
      for (const field of [
        "emailVerification",
        "phoneVerification",
        "emailVerified",
      ]) {
        const response = await post("/profiles/me/contact", account.token, {
          expectedRevision: 0,
          address: "Do not save",
          [field]: true,
        });
        assert.notEqual(response.status, 200);
        assert.notEqual((await profile(account)).address, "Do not save");
      }
      ok(await post("/auth/logout", account.token, {}));
      assert.notEqual((await complete(account, code)).status, 200);
    });

    test("owned API process restart preserves contact cooldowns and cannot enable sender credentials in TEST", async () => {
      const account = await person();
      for (let index = 0; index < 5; index++)
        denied(
          await post("/contacts/identity/start", account.token, {
            type: "email",
            destination: "new@example.invalid",
            password: "Wrong synthetic password",
            expectedRevision: 0,
          }),
          "contact_verification_failed",
        );
      let owned = await startIsolatedApiProcess();
      try {
        const status = ok(
          await owned.request("/contacts/status", { token: account.token }),
        );
        assert.equal(status.emailReady, false);
        denied(
          await owned.request("/contacts/identity/start", {
            token: account.token,
            body: {
              type: "email",
              destination: "new@example.invalid",
              password: account.password,
              expectedRevision: 0,
            },
          }),
          "contact_try_later",
          429,
        );
        const firstPid = owned.pid;
        await owned.stop();
        owned = await startIsolatedApiProcess();
        assert.notEqual(owned.pid, firstPid);
        denied(
          await owned.request("/contacts/identity/start", {
            token: account.token,
            body: {
              type: "email",
              destination: "new@example.invalid",
              password: account.password,
              expectedRevision: 0,
            },
          }),
          "contact_try_later",
          429,
        );
        ok(await owned.request("/workspace", { token: account.token }));
        assert.equal(messages.length, 0);
      } finally {
        await owned.stop();
      }
    });
  },
);
