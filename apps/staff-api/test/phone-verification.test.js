import assert from "node:assert/strict";
import { before, after, beforeEach, describe, test } from "node:test";
import { createSecurityFixture } from "./helpers/security-fixture.js";

describe(
  "guarded manual staff phone verification; no external opening",
  { concurrency: false },
  () => {
    let f;
    before(async () => {
      f = await createSecurityFixture();
    });
    beforeEach(async () => f.reset());
    after(async () => {
      await f.reset();
      await f.close();
    });
    const post = (path, token, body) =>
      f.request(path, { method: "POST", token, body });
    const ok = (r) => {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    async function person(roles = ["Receptionist"]) {
      const p = await f.account({
        roles,
        mfa: roles.some((r) => r !== "Receptionist"),
      });
      let r = ok(
        await post("/auth/login", null, {
          username: p.username,
          password: p.password,
        }),
      );
      if (r.challenge)
        r = ok(
          await post("/mfa/complete", null, {
            challenge: r.challenge,
            code: await f.totp(p.secret),
          }),
        );
      await f.db
        .collection("staff_profiles")
        .updateOne(
          { accountId: p.id },
          { $set: { phone: "71-123456", phoneCountry: "LB" } },
        );
      return { ...p, ...r };
    }
    async function begin(p) {
      return ok(
        await post("/contacts/identity/start", p.token, {
          type: "phone",
          destination: "+96171123456",
          password: p.password,
          expectedRevision: 0,
        }),
      );
    }
    async function prepare(a, p) {
      return post("/contacts/phone/prepare", a.token, { accountId: p.id });
    }
    test("employee cannot retrieve code; another fresh Admin prepares same protected code and proof preserves saved digits", async () => {
      const p = await person(),
        a = await person(["Admin"]);
      const pending = await begin(p);
      assert.equal(pending.manualDelivery, true);
      assert.equal(pending.sent, false);
      assert.equal(JSON.stringify(pending).includes("code"), false);
      const row = await f.db
        .collection("contact_requests")
        .findOne({ accountId: p.id });
      assert(row.codeCipher);
      assert(row.codeHash);
      assert.equal(Object.hasOwn(row, "code"), false);
      assert.equal((await prepare(p, p)).status, 403);
      const before = await f.db
        .collection("staff_profiles")
        .findOne({ accountId: p.id });
      const m = ok(await prepare(a, p)),
        again = ok(await prepare(a, p));
      assert.equal(m.generation, again.generation);
      assert.equal(m.message, again.message);
      assert.equal(m.phone, "+96171123456");
      const code = m.message.match(/code: (\d{8})/)[1];
      const status = ok(
        await f.request("/contacts/status", { token: p.token }),
      );
      assert.equal(status.phonePending.generation, m.generation);
      assert(!JSON.stringify(status).includes(code));
      ok(
        await post("/contacts/phone/opened", a.token, {
          accountId: p.id,
          generation: m.generation,
        }),
      );
      const done = ok(
        await post("/contacts/complete", p.token, { type: "phone", code }),
      );
      assert.equal(done.testOnly, true);
      const saved = await f.db
        .collection("staff_profiles")
        .findOne({ accountId: p.id });
      assert.equal(saved.phone, before.phone);
      assert.equal(saved.phoneVerification.provider, "manual_whatsapp");
      assert.equal(saved.revision, 1);
      assert.equal(
        (await post("/contacts/complete", p.token, { type: "phone", code }))
          .status,
        401,
      );
      const consumed = await f.db
        .collection("contact_requests")
        .findOne({ accountId: p.id });
      assert(!consumed.codeCipher);
      assert(!consumed.codeHash);
      const events = await f.db
        .collection("security_events")
        .find({})
        .toArray();
      assert(!JSON.stringify(events).includes(code));
      assert.equal(
        await f.db.collection("contact_delivery_budgets").countDocuments(),
        0,
      );
    });
    test("wrong saved destination, invalid Lebanese prefix, wrong password and non-Admin preparation are rejected", async () => {
      const p = await person(),
        manager = await person(["Clinic Admin"]);
      assert.equal(
        (
          await post("/contacts/identity/start", p.token, {
            type: "phone",
            destination: "+96176123456",
            password: p.password,
            expectedRevision: 0,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await post("/contacts/identity/start", p.token, {
            type: "phone",
            destination: "+96171123456",
            password: "wrong",
            expectedRevision: 0,
          })
        ).status,
        401,
      );
      await begin(p);
      assert.equal((await prepare(manager, p)).status, 403);
      await f.db
        .collection("staff_profiles")
        .updateOne({ accountId: p.id }, { $set: { phone: "11-123456" } });
      assert.equal(
        (
          await post("/contacts/identity/start", p.token, {
            type: "phone",
            destination: "+96111123456",
            password: p.password,
            expectedRevision: 0,
          })
        ).status,
        400,
      );
    });
    test("resend replaces code without extending expiry, cancellation removes private code and stale generation cannot open", async () => {
      const p = await person(),
        a = await person(["Admin"]);
      const first = await begin(p),
        m = ok(await prepare(a, p));
      f.advance(60000);
      const next = ok(
        await post("/contacts/resend", p.token, { type: "phone" }),
      );
      assert.equal(next.expiresAt, first.expiresAt);
      assert.notEqual(next.generation, m.generation);
      assert.equal(
        (
          await post("/contacts/phone/opened", a.token, {
            accountId: p.id,
            generation: m.generation,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await post("/contacts/complete", p.token, {
            type: "phone",
            code: m.message.match(/code: (\d{8})/)[1],
          })
        ).status,
        401,
      );
      ok(await post("/contacts/cancel", p.token, { type: "phone" }));
      assert.equal((await prepare(a, p)).status, 409);
      assert(
        !(
          await f.db.collection("contact_requests").findOne({ accountId: p.id })
        ).codeCipher,
      );
    });
    test("expiry, revoked employee session and stale profile deny Admin code retrieval without restoring old proof", async () => {
      const p = await person(),
        a = await person(["Admin"]);
      await begin(p);
      await f.db
        .collection("staff_profiles")
        .updateOne({ accountId: p.id }, { $set: { revision: 1 } });
      assert.equal((await prepare(a, p)).status, 409);
      await f.db
        .collection("staff_profiles")
        .updateOne({ accountId: p.id }, { $set: { revision: 0 } });
      await f.db
        .collection("staff_sessions")
        .updateMany({ accountId: p.id }, { $set: { revokedAt: f.clock() } });
      assert.equal((await prepare(a, p)).status, 409);
      const saved = await f.db
        .collection("staff_profiles")
        .findOne({ accountId: p.id });
      assert.equal(saved.phoneVerification, undefined);
    });
    test("actual deadlines and fresh Admin proof are required; parallel completion has one winner", async () => {
      const p = await person(),
        a = await person(["Admin"]);
      await begin(p);
      await f.db.collection("staff_sessions").updateMany(
        { accountId: a.id },
        {
          $set: {
            passwordVerifiedAt: new Date(0),
            mfaVerifiedAt: new Date(0),
          },
        },
      );
      assert.equal((await prepare(a, p)).status, 403);
      const fresh = await person(["Admin"]);
      const m = ok(await prepare(fresh, p));
      const code = m.message.match(/code: (\d{8})/)[1];
      const results = await Promise.all([
        post("/contacts/complete", p.token, { type: "phone", code }),
        post("/contacts/complete", p.token, { type: "phone", code }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
      const expired = await person();
      await begin(expired);
      f.advance(600000);
      const laterAdmin = await person(["Admin"]);
      assert.equal((await prepare(laterAdmin, expired)).status, 409);
      assert.equal(
        (
          await post("/contacts/complete", expired.token, {
            type: "phone",
            code: "00000000",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await f.db
            .collection("staff_profiles")
            .findOne({ accountId: expired.id })
        ).phoneVerification,
        undefined,
      );
    });
  },
);
