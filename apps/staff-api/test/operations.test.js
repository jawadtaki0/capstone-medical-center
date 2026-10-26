import assert from "node:assert/strict";
import { before, after, beforeEach, describe, test } from "node:test";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";

describe(
  "isolated professional/schedule authority",
  { concurrency: false },
  () => {
    let f, admin;
    const ok = (r) => {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const post = (token, action, body) =>
      f.request(`/operations/${action}`, { method: "POST", token, body });
    async function actor(roles = ["Admin"]) {
      const a = await f.account({
        roles,
        mfa: roles.some((r) => !r.includes("Receptionist")),
      });
      let login = ok(
        await f.request("/auth/login", {
          method: "POST",
          body: { username: a.username, password: a.password },
        }),
      );
      if (!login.token)
        login = ok(
          await f.request("/mfa/complete", {
            method: "POST",
            body: { challenge: login.challenge, code: await f.totp(a.secret) },
          }),
        );
      return { ...a, ...login };
    }
    const save = (type, record, expectedRevision = 0, token = admin.token) =>
      post(token, "save", { type, record, expectedRevision });
    const scope = (id = "clinic-one", kind = "clinic") => ({
      id,
      name: `Synthetic ${id}`,
      kind,
      active: true,
    });
    const profile = (extra = {}) => ({
      id: "doctor:synthetic",
      name: "Dr. Synthetic Professional",
      specialty: "Dentistry",
      kind: "doctor",
      gender: "male",
      active: true,
      scopeIds: ["clinic-one"],
      ...extra,
    });
    const session = (extra = {}) => ({
      id: "session-one",
      scopeId: "clinic-one",
      professionalId: "doctor:synthetic",
      weekday: 1,
      startTime: "09:00",
      endTime: "11:00",
      capacity: 4,
      status: "active",
      appointmentRequired: false,
      ...extra,
    });
    const read = async (token = admin.token) =>
      ok(await f.request("/operations", { token }));
    async function setup() {
      ok(await save("scopes", scope()));
      ok(await save("professionals", profile()));
      for (let day = 0; day < 7; day++)
        ok(
          await save("hours", {
            id: String(day),
            closed: day === 0,
            ...(day
              ? { startTime: "08:00", endTime: day === 6 ? "13:00" : "17:00" }
              : {}),
          }),
        );
    }
    async function publish(scopeIds = ["clinic-one"]) {
      const state = await read();
      return post(admin.token, "publish", {
        scopeIds,
        expectedRevision: state.revision,
        expectedHead: state.head,
        effectiveFrom: "2026-10-19",
        confirmed: true,
      });
    }
    before(async () => {
      f = await createSecurityFixture();
    });
    beforeEach(async () => {
      await f.reset();
      admin = await actor();
    });
    after(async () => {
      if (f) {
        await f.reset();
        await f.close();
      }
    });

    test("all roles, mixed roles, explicit Audiometry service grant and departments never confer authority", async () => {
      await setup();
      ok(await save("scopes", scope("audiometry", "service")));
      for (const roles of [
        ["Clinic Admin"],
        ["Lab Admin"],
        ["Receptionist"],
        ["Clinic Admin", "Receptionist"],
        ["Lab Admin", "Receptionist"],
        ["Clinic Admin", "Lab Admin"],
      ]) {
        const a = await actor(roles);
        assert.equal((await read(a.token)).scopes.length, 0);
        ok(
          await post(admin.token, "grants", {
            accountId: a.id,
            scopeIds: ["clinic-one", "audiometry"],
            expectedRevision: 0,
            confirmed: true,
          }),
        );
        const state = await read(a.token);
        const clinic = state.scopes.find((s) => s.id === "clinic-one"),
          audio = state.scopes.find((s) => s.id === "audiometry");
        assert.equal(
          Boolean(clinic),
          roles.some((r) => ["Clinic Admin", "Receptionist"].includes(r)),
        );
        assert.equal(
          Boolean(audio),
          roles.some((r) => ["Lab Admin", "Receptionist"].includes(r)),
        );
        if (roles.includes("Lab Admin")) {
          ok(
            await save(
              "sessions",
              session({
                id: `audio-hour:${a.id}`,
                scopeId: "audiometry",
                professionalId: null,
                capacity: null,
              }),
              0,
              a.token,
            ),
          );
          assert.equal(
            (
              await save(
                "professionals",
                profile({ name: "FORBIDDEN" }),
                1,
                a.token,
              )
            ).status,
            roles.includes("Clinic Admin") ? 200 : 403,
          );
        }
        if (!roles.includes("Clinic Admin"))
          assert.equal(
            (await save("sessions", session(), 0, a.token)).status,
            403,
          );
      }
    });
    test("forged fields, stale revisions, atomic rejection and current revoked grants", async () => {
      await setup();
      const a = await actor(["Clinic Admin"]);
      ok(
        await post(admin.token, "grants", {
          accountId: a.id,
          scopeIds: ["clinic-one"],
          expectedRevision: 0,
          confirmed: true,
        }),
      );
      assert.equal(
        (
          await save(
            "professionals",
            { ...profile(), roles: ["Admin"] },
            1,
            a.token,
          )
        ).status,
        400,
      );
      assert.equal(
        (await save("professionals", profile({ name: "Stale" }), 0, a.token))
          .status,
        409,
      );
      assert.equal((await read()).professionals[0].name, profile().name);
      ok(
        await post(admin.token, "grants", {
          accountId: a.id,
          scopeIds: [],
          expectedRevision: 1,
          confirmed: true,
        }),
      );
      assert.equal((await save("sessions", session(), 0, a.token)).status, 403);
    });
    test("manual 3 and null persist through hours/specialty edits and dated replacement publication without public leakage", async () => {
      await setup();
      ok(await save("sessions", session({ capacity: 3, endTime: "10:07" })));
      ok(await save("professionals", profile({ specialty: "Therapist" }), 1));
      assert.equal((await read()).sessions[0].capacity, 3);
      ok(
        await save(
          "sessions",
          session({ capacity: 3, startTime: "09:07", endTime: "10:13" }),
          1,
        ),
      );
      ok(
        await save("exceptions", {
          id: "manual-date",
          scopeId: "clinic-one",
          date: "2026-10-19",
          closed: false,
          sessions: [
            session({ capacity: null, startTime: "10:13", endTime: "11:07" }),
          ],
        }),
      );
      ok(await publish());
      const projected = ok(
        await post(admin.token, "preview", { date: "2026-10-19" }),
      );
      assert.equal(projected.schedule.doctorSessions[0].startTime, "10:13");
      assert.equal(JSON.stringify(projected).includes('"capacity"'), false);
      const data = await read();
      assert.equal(data.sessions[0].capacity, 3);
      assert.equal(data.exceptions[0].sessions[0].capacity, null);
      const before = structuredClone(data);
      assert.equal(
        (await save("sessions", session({ capacity: 3.5 }), 2)).status,
        400,
      );
      assert.deepEqual((await read()).sessions, before.sessions);
    });
    test("concurrent cross-clinic overlaps have one winner; adjacency and scope-only dated closures work", async () => {
      await setup();
      ok(await save("scopes", scope("clinic-two")));
      ok(
        await save(
          "professionals",
          profile({ scopeIds: ["clinic-one", "clinic-two"] }),
          1,
        ),
      );
      const results = await Promise.all([
        save("sessions", session()),
        save(
          "sessions",
          session({ id: "other", scopeId: "clinic-two", startTime: "10:00" }),
        ),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const winner = (await read()).sessions[0];
      ok(
        await save(
          "sessions",
          session({
            id: "adjacent",
            scopeId:
              winner.scopeId === "clinic-one" ? "clinic-two" : "clinic-one",
            startTime: "11:00",
            endTime: "12:00",
          }),
        ),
      );
      ok(
        await save("exceptions", {
          id: "leave",
          scopeId: winner.scopeId,
          date: "2026-10-19",
          closed: true,
          sessions: [],
        }),
      );
      const projected = await read();
      assert.equal(projected.exceptions.length, 1);
      assert.equal(projected.sessions.length, 2);
    });
    test("publication isolates drafts; unset limits publish privately; stale publish and inactive professionals cannot silently break references", async () => {
      await setup();
      ok(await save("sessions", session({ capacity: null })));
      ok(await publish());
      assert.equal((await read()).sessions[0].capacity, null);
      ok(await save("sessions", session(), 1));
      ok(await publish());
      const snapshot = ok(
        await post(admin.token, "preview", { date: "2026-10-19" }),
      );
      assert.equal(
        snapshot.schedule.doctorSessions[0].doctorName,
        profile().name,
      );
      assert.equal(snapshot.professionals.professionals.length, 1);
      ok(await save("professionals", profile({ name: "Unpublished name" }), 1));
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-10-19" })).schedule
          .doctorSessions[0].doctorName,
        profile().name,
      );
      const state = await read();
      const stale = await post(admin.token, "publish", {
        scopeIds: ["clinic-one"],
        expectedRevision: state.revision - 1,
        expectedHead: state.head,
        effectiveFrom: "2026-10-19",
        confirmed: true,
      });
      assert.equal(stale.status, 409);
      ok(await save("professionals", profile({ active: false }), 2));
      assert.equal((await publish()).body.error.code, "publication_incomplete");
      ok(await save("sessions", session({ status: "cancelled" }), 2));
      ok(await publish());
      const retired = ok(
        await post(admin.token, "preview", { date: "2026-10-19" }),
      );
      assert.equal(retired.professionals.professionals.length, 0);
      assert.equal(retired.schedule.doctorSessions[0].status, "cancelled");
      assert.equal(
        await f.db.collection("operational_publications").countDocuments({}),
        3,
      );
      assert.equal((await read()).professionals[0].active, false);
    });
    test("scoped publication preserves other clinics and unconfirmed unrelated drafts; Lab Admin can publish explicitly assigned Audiometry only", async () => {
      await setup();
      ok(await save("sessions", session()));
      ok(await save("scopes", scope("audiometry", "service")));
      ok(
        await save(
          "sessions",
          session({
            id: "audio",
            scopeId: "audiometry",
            professionalId: null,
            capacity: null,
          }),
        ),
      );
      ok(await publish(["clinic-one", "audiometry"]));
      const lab = await actor(["Lab Admin"]);
      ok(
        await post(admin.token, "grants", {
          accountId: lab.id,
          scopeIds: ["audiometry"],
          expectedRevision: 0,
          confirmed: true,
        }),
      );
      ok(
        await save(
          "sessions",
          session({
            id: "audio",
            scopeId: "audiometry",
            professionalId: null,
            capacity: null,
            endTime: "12:00",
          }),
          1,
          lab.token,
        ),
      );
      ok(await save("sessions", session({ capacity: null }), 1));
      const state = await read(lab.token);
      ok(
        await post(lab.token, "publish", {
          scopeIds: ["audiometry"],
          expectedRevision: state.revision,
          expectedHead: state.head,
          effectiveFrom: "2026-10-19",
          confirmed: true,
        }),
      );
      const published = ok(
        await post(admin.token, "preview", { date: "2026-10-19" }),
      );
      assert.equal(published.schedule.doctorSessions.length, 1);
      assert.equal(
        published.schedule.otherServices[0].name,
        "Synthetic audiometry",
      );
      assert.equal(published.schedule.otherServices[0].endTime, "12:00");
      assert.equal(
        (
          await post(lab.token, "publish", {
            scopeIds: ["clinic-one"],
            expectedRevision: state.revision,
            expectedHead: state.head,
            effectiveFrom: "2026-10-19",
            confirmed: true,
          })
        ).status,
        403,
      );
    });
    test("publication conflicts have one winner; future versions do not rewrite earlier dates, and explicit center holidays are date-only", async () => {
      await setup();
      ok(await save("sessions", session()));
      const state = await read(),
        payload = {
          scopeIds: ["clinic-one"],
          expectedRevision: state.revision,
          expectedHead: state.head,
          effectiveFrom: "2026-10-19",
          confirmed: true,
        };
      const concurrent = await Promise.all([
        post(admin.token, "publish", payload),
        post(admin.token, "publish", payload),
      ]);
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
      ok(await save("hours", { id: "2026-10-26", closed: true }));
      const next = await read();
      ok(
        await post(admin.token, "publish", {
          ...payload,
          expectedRevision: next.revision,
          expectedHead: next.head,
          effectiveFrom: "2026-10-26",
        }),
      );
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-10-19" })).schedule
          .doctorSessions.length,
        1,
      );
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-10-26" })).schedule
          .centerClosed,
        true,
      );
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-11-02" })).schedule
          .doctorSessions.length,
        1,
      );
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-10-18" }))
          .unpublished,
        true,
      );
    });
    test("shared professional fields require all linked scopes and manager changes never grant authority through profile fields", async () => {
      await setup();
      ok(await save("scopes", scope("clinic-two")));
      ok(
        await save(
          "professionals",
          profile({ scopeIds: ["clinic-one", "clinic-two"] }),
          1,
        ),
      );
      const clinic = await actor(["Clinic Admin"]);
      ok(
        await post(admin.token, "grants", {
          accountId: clinic.id,
          scopeIds: ["clinic-one"],
          expectedRevision: 0,
          confirmed: true,
        }),
      );
      assert.equal((await read(clinic.token)).professionals[0].canEdit, false);
      assert.equal(
        (
          await save(
            "professionals",
            profile({ name: "Unauthorized", scopeIds: ["clinic-one"] }),
            2,
            clinic.token,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post(clinic.token, "grants", {
            accountId: clinic.id,
            scopeIds: ["clinic-two"],
            expectedRevision: 1,
            confirmed: true,
          })
        ).status,
        403,
      );
      assert.equal(
        (await save("scopes", scope("injected"), 0, clinic.token)).status,
        403,
      );
      assert.equal((await read()).professionals[0].name, profile().name);
    });
    test("current account status, session expiry and recent verification are enforced; failure does not save partial registry edits", async () => {
      await setup();
      f.advance(5 * 60000 + 1);
      assert.equal(
        (await save("scopes", scope("too-old"))).body.error.code,
        "verification_required",
      );
      assert.equal((await read()).scopes.length, 1);
      f.advance(5 * 60000);
      assert.equal(
        (await f.request("/operations", { token: admin.token })).status,
        401,
      );
      const disabled = await actor(["Clinic Admin"]);
      await f.db
        .collection("accounts")
        .updateOne({ _id: disabled.id }, { $set: { status: "disabled" } });
      assert.equal(
        (await f.request("/operations", { token: disabled.token })).status,
        401,
      );
    });
    test("rollback and owned API/database reconnect preserve previous drafts, immutable versions and account security", async () => {
      await setup();
      ok(await save("sessions", session()));
      ok(await publish());
      const beforeProfile = await f.db
        .collection("staff_profiles")
        .findOne({ accountId: admin.id });
      const beforeAccount = await f.db
        .collection("accounts")
        .findOne({ _id: admin.id });
      await f.restart({ failAudit: true });
      assert.equal(
        (await save("sessions", session({ endTime: "12:00" }), 1)).status,
        503,
      );
      await f.restart({ reconnect: true });
      assert.equal((await read()).sessions[0].endTime, "11:00");
      assert.equal((await read()).head, 1);
      assert.deepEqual(
        await f.db.collection("accounts").findOne({ _id: admin.id }),
        beforeAccount,
      );
      assert.deepEqual(
        await f.db
          .collection("staff_profiles")
          .findOne({ accountId: admin.id }),
        beforeProfile,
      );
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-10-19" })).schedule
          .doctorSessions.length,
        1,
      );
    });
    test("dated replacement overlap and missing references reject atomically; cancelled and specialist sessions remain supported", async () => {
      await setup();
      ok(await save("scopes", scope("clinic-two")));
      ok(
        await save(
          "professionals",
          profile({ scopeIds: ["clinic-one", "clinic-two"] }),
          1,
        ),
      );
      ok(await save("sessions", session()));
      ok(
        await save(
          "sessions",
          session({
            id: "two",
            scopeId: "clinic-two",
            startTime: "12:00",
            endTime: "13:00",
            capacity: 2,
          }),
        ),
      );
      const failed = await save("exceptions", {
        id: "overlap",
        scopeId: "clinic-one",
        date: "2026-10-19",
        closed: false,
        sessions: [session({ startTime: "12:30", endTime: "13:30" })],
      });
      assert.equal(failed.body.error.code, "schedule_overlap");
      assert.equal((await read()).exceptions.length, 0);
      assert.equal(
        (
          await save(
            "sessions",
            session({ id: "broken", professionalId: "doctor:missing" }),
          )
        ).status,
        400,
      );
      ok(
        await save(
          "professionals",
          profile({
            id: "specialist:synthetic",
            kind: "specialist",
            name: "Synthetic Therapist",
            specialty: "Therapist",
          }),
        ),
      );
      ok(
        await save(
          "sessions",
          session({
            id: "specialist-session",
            professionalId: "specialist:synthetic",
            status: "cancelled",
          }),
        ),
      );
      ok(await publish(["clinic-one", "clinic-two"]));
      const view = ok(
        await post(admin.token, "preview", { date: "2026-10-19" }),
      );
      assert.equal(
        view.schedule.specialistSessions[0].name,
        "Synthetic Therapist",
      );
      assert.equal(view.schedule.specialistSessions[0].status, "cancelled");
    });
    test("separate owned API processes share persistent drafts, publications and cross-process conflict protection", async () => {
      await setup();
      let child = await startIsolatedApiProcess();
      try {
        ok(
          await child.request("/operations/save", {
            token: admin.token,
            body: { type: "sessions", expectedRevision: 0, record: session() },
          }),
        );
      } finally {
        await child.stop();
      }
      child = await startIsolatedApiProcess();
      try {
        assert.equal(
          ok(await child.request("/operations", { token: admin.token }))
            .sessions[0].capacity,
          4,
        );
        const state = await read(),
          payload = {
            scopeIds: ["clinic-one"],
            expectedRevision: state.revision,
            expectedHead: state.head,
            effectiveFrom: "2026-10-19",
            confirmed: true,
          };
        const race = await Promise.all([
          post(admin.token, "publish", payload),
          child.request("/operations/publish", {
            token: admin.token,
            body: payload,
          }),
        ]);
        assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          ok(
            await child.request("/operations/preview", {
              token: admin.token,
              body: { date: "2026-10-19" },
            }),
          ).schedule.doctorSessions.length,
          1,
        );
      } finally {
        await child.stop();
      }
    });
    test("later current-date publications preserve independent future plans", async () => {
      await setup();
      ok(await save("sessions", session()));
      ok(await publish());
      ok(await save("scopes", scope("audiometry", "service")));
      ok(
        await save(
          "sessions",
          session({
            id: "future-audio",
            scopeId: "audiometry",
            professionalId: null,
            capacity: null,
          }),
        ),
      );
      let state = await read();
      ok(
        await post(admin.token, "publish", {
          scopeIds: ["audiometry"],
          expectedRevision: state.revision,
          expectedHead: state.head,
          effectiveFrom: "2026-11-01",
          confirmed: true,
        }),
      );
      ok(
        await save(
          "professionals",
          profile({ name: "Current corrected name" }),
          1,
        ),
      );
      state = await read();
      ok(
        await post(admin.token, "publish", {
          scopeIds: ["clinic-one"],
          expectedRevision: state.revision,
          expectedHead: state.head,
          effectiveFrom: "2026-10-20",
          confirmed: true,
        }),
      );
      const future = ok(
        await post(admin.token, "preview", { date: "2026-11-02" }),
      );
      assert.equal(
        future.schedule.doctorSessions[0].doctorName,
        "Current corrected name",
      );
      assert.equal(
        future.schedule.otherServices[0].name,
        "Synthetic audiometry",
      );
      assert.equal(
        ok(await post(admin.token, "preview", { date: "2026-10-26" })).schedule
          .otherServices.length,
        0,
      );
    });
    test("current publication revalidates already-published future cross-clinic conflicts atomically", async () => {
      await setup();
      ok(await save("scopes", scope("clinic-two")));
      ok(
        await save(
          "professionals",
          profile({ scopeIds: ["clinic-one", "clinic-two"] }),
          1,
        ),
      );
      ok(await save("sessions", session()));
      ok(
        await save(
          "sessions",
          session({
            id: "second",
            scopeId: "clinic-two",
            startTime: "14:00",
            endTime: "15:00",
            capacity: 2,
          }),
        ),
      );
      ok(await publish(["clinic-one", "clinic-two"]));
      ok(
        await save(
          "sessions",
          session({
            id: "second",
            scopeId: "clinic-two",
            startTime: "12:00",
            endTime: "13:00",
            capacity: 2,
          }),
          1,
        ),
      );
      let state = await read();
      ok(
        await post(admin.token, "publish", {
          scopeIds: ["clinic-two"],
          expectedRevision: state.revision,
          expectedHead: state.head,
          effectiveFrom: "2026-11-01",
          confirmed: true,
        }),
      );
      ok(
        await save(
          "sessions",
          session({
            id: "second",
            scopeId: "clinic-two",
            startTime: "14:00",
            endTime: "15:00",
            capacity: 2,
          }),
          2,
        ),
      );
      ok(
        await save(
          "sessions",
          session({ startTime: "12:30", endTime: "13:30", capacity: 2 }),
          1,
        ),
      );
      state = await read();
      const denied = await post(admin.token, "publish", {
        scopeIds: ["clinic-one"],
        expectedRevision: state.revision,
        expectedHead: state.head,
        effectiveFrom: "2026-10-20",
        confirmed: true,
      });
      assert.equal(denied.body.error.code, "schedule_overlap");
      assert.equal((await read()).head, 2);
      assert.equal(
        await f.db.collection("operational_publications").countDocuments({}),
        2,
      );
    });
    test("receptionist sees only current published schedules, not pending draft changes", async () => {
      await setup();
      ok(await save("sessions", session()));
      const receptionist = await actor(["Receptionist"]);
      ok(
        await post(admin.token, "grants", {
          accountId: receptionist.id,
          scopeIds: ["clinic-one"],
          expectedRevision: 0,
          confirmed: true,
        }),
      );
      assert.equal((await read(receptionist.token)).sessions.length, 0);
      ok(await publish());
      ok(await save("sessions", session({ endTime: "12:00" }), 1));
      f.advance(+new Date("2026-10-20T09:00:00Z") - +f.clock());
      const signedIn = ok(
        await f.request("/auth/login", {
          method: "POST",
          body: {
            username: receptionist.username,
            password: receptionist.password,
          },
        }),
      );
      assert.equal((await read(signedIn.token)).sessions[0].endTime, "11:00");
    });
  },
);
