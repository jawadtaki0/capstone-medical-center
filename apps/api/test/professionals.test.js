import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { getPublicProfessionals } from "../src/professionals.js";
import { COLLECTIONS } from "../src/schedule-model.js";

function profile(_id, name, specialty = "Synthetic specialty", extra = {}) {
  return {
    _id, name, specialty, active: true, ...extra,
  };
}

function profileDatabase(doctors = [], specialists = []) {
  const calls = [];
  const rows = new Map([[COLLECTIONS.doctors, doctors], [COLLECTIONS.specialists, specialists]]);
  return {
    calls,
    collection(name) {
      assert.ok(rows.has(name), "Directory must not query schedules or other collections");
      return {
        find(query, options) {
          assert.deepEqual(query, { active: true });
          assert.deepEqual(options, { projection: { _id: 1, name: 1, specialty: 1, gender: 1 } });
          calls.push({ name, operation: "find", query, options });
          // Deliberately return extra fields to also test the DTO allowlist.
          return { async toArray() {
            return rows.get(name).filter((row) => Object.entries(query)
              .every(([key, value]) => row[key] === value));
          } };
        },
      };
    },
  };
}

test("directory includes doctors and specialists, without any session dependency or writes", async () => {
  const db = profileDatabase(
    [profile("doctor-synthetic", "Dr. Synthetic Doctor", "Synthetic specialty", { gender: "male" })],
    [profile("specialist-synthetic", "Synthetic Specialist", "Dietitian", { gender: "female" })],
  );
  assert.deepEqual(await getPublicProfessionals(db), { professionals: [
    { id: "doctor-synthetic", name: "Dr. Synthetic Doctor", specialty: "Synthetic specialty", kind: "doctor", avatarVariant: "male" },
    { id: "specialist-synthetic", name: "Synthetic Specialist", specialty: "Dietitian", kind: "specialist", avatarVariant: "female" },
  ] });
  assert.deepEqual(db.calls.map(({ name, operation }) => [name, operation]), [
    [COLLECTIONS.doctors, "find"], [COLLECTIONS.specialists, "find"],
  ]);
});

test("active profiles need no center or publication fields; inactive or missing-active profiles stay hidden", async () => {
  const rows = [
    profile("synthetic-visible", "Synthetic Visible"),
    profile("synthetic-inactive", "Synthetic Inactive", "Test", { active: false }),
    profile("synthetic-stale-publication", "Synthetic Stale Publication", "Test", { publicationStatus: "draft" }),
    profile("synthetic-stale-center", "Synthetic Stale Center", "Test", { centerId: "synthetic-old-center" }),
    profile("synthetic-missing-active", "Synthetic Missing Active", "Test", { active: undefined }),
    profile("synthetic-invalid-active", "Synthetic Invalid Active", "Test", { active: "true" }),
  ];
  for (const kind of ["doctor", "specialist"]) {
    const db = kind === "doctor" ? profileDatabase(rows) : profileDatabase([], rows);
    const { professionals } = await getPublicProfessionals(db);
    assert.deepEqual(professionals.map(({ id }) => id).sort(), [
      "synthetic-stale-center", "synthetic-stale-publication", "synthetic-visible",
    ]);
    assert.equal(professionals.every((professional) => professional.kind === kind), true);
  }
});

test("projection reads gender, but public DTO exposes only id, exact name/specialty, kind and avatar variant", async () => {
  const db = profileDatabase([profile("synthetic:private", "Dr. Synthetic Exact Name", "Synthetic & Exact Specialty", {
    privatePhone: "synthetic-private", internalNotes: "synthetic-private",
    adminUserId: "synthetic-admin", gender: "female", seedId: "synthetic-seed",
    active: true, centerId: "synthetic-legacy-center", publicationStatus: "synthetic-legacy-publication",
  })]);
  assert.deepEqual((await getPublicProfessionals(db)).professionals, [
    { id: "synthetic:private", name: "Dr. Synthetic Exact Name", specialty: "Synthetic & Exact Specialty", kind: "doctor", avatarVariant: "female" },
  ]);
});

test("directory is deterministically sorted by name then stable id and is not truncated", async () => {
  const db = profileDatabase([
    profile("synthetic:z", "Synthetic Same"), profile("synthetic:middle", "Synthetic Middle"),
  ], [profile("synthetic:a", "Synthetic Same"), profile("synthetic:first", "Synthetic First")]);
  const { professionals } = await getPublicProfessionals(db);
  assert.deepEqual(professionals.map(({ id }) => id), [
    "synthetic:first", "synthetic:middle", "synthetic:a", "synthetic:z",
  ]);
  assert.equal(professionals.length, 4);
});

test("an actually empty directory returns an empty list, not fallback professionals", async () => {
  assert.deepEqual(await getPublicProfessionals(profileDatabase()), { professionals: [] });
});

test("avatar variants come only from stored gender and safely fall back to neutral in both groups", async () => {
  const records = [
    profile("synthetic-male", "Synthetic A", "Test", { gender: "male" }),
    profile("synthetic-female", "Synthetic B", "Test", { gender: "female" }),
    profile("synthetic-missing", "Synthetic C"),
    profile("synthetic-unknown", "Synthetic D", "Test", { gender: "unknown" }),
    profile("synthetic-invalid", "Synthetic E", "Test", { gender: { value: "male" } }),
  ];
  for (const kind of ["doctor", "specialist"]) {
    const db = kind === "doctor" ? profileDatabase(records) : profileDatabase([], records);
    const { professionals } = await getPublicProfessionals(db);
    assert.deepEqual(professionals.map(({ avatarVariant }) => avatarVariant), [
      "male", "female", "neutral", "neutral", "neutral",
    ]);
    assert.equal(professionals.every((professional) => professional.kind === kind), true);
  }
});

test("invalid eligible fields and duplicate identifiers fail instead of silently hiding records", async () => {
  for (const invalid of [
    profile("synthetic:bad-name", ""), profile("synthetic:bad-specialty", "Synthetic", null),
    profile(42, "Synthetic Invalid ID"), profile({ toString: () => "synthetic-id" }, "Synthetic Object ID"),
  ]) {
    await assert.rejects(getPublicProfessionals(profileDatabase([invalid])), /invalid directory fields/);
  }
  await assert.rejects(getPublicProfessionals(profileDatabase(
    [profile("synthetic:duplicate", "Synthetic Doctor")],
    [profile("synthetic:duplicate", "Synthetic Specialist")],
  )), /identifiers must be unique/);
});

async function apiResponse(context, professionalsReader, method = "GET") {
  const server = createApp({
    professionalsReader,
    scheduleReader: () => { throw new Error("Directory must not depend on schedules"); },
  }).listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/professionals`, { method });
  return { status: response.status, body: await response.json() };
}

test("GET /api/professionals returns the public projected profiles", async (context) => {
  const db = profileDatabase([profile("synthetic:doctor", "Dr. Synthetic", "Synthetic", {
    privateField: "never public",
  })], [profile("synthetic:specialist", "Synthetic Specialist", "Dietitian")]);
  const response = await apiResponse(context, () => getPublicProfessionals(db));
  assert.equal(response.status, 200);
  assert.equal(response.body.professionals.length, 2);
  for (const professional of response.body.professionals) {
    assert.deepEqual(Object.keys(professional).sort(), ["avatarVariant", "id", "kind", "name", "specialty"]);
  }
});

test("directory API has no unauthenticated write endpoints", async (context) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await apiResponse(context, () => { throw new Error("Must not read or write"); }, method);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "not_found");
  }
});

test("database outage or invalid eligible records return a retryable 503 without private details", async (context) => {
  const readers = [
    () => getPublicProfessionals(), // Tests never connect to the live database.
    async () => { throw new Error("Synthetic private failure details"); },
    () => getPublicProfessionals(profileDatabase([profile("synthetic:bad", "", "Synthetic")])),
  ];
  for (const reader of readers) {
    const response = await apiResponse(context, reader);
    assert.equal(response.status, 503);
    assert.equal(response.body.error, "directory_unavailable");
    assert.equal(JSON.stringify(response.body).includes("private failure"), false);
    assert.equal(Object.hasOwn(response.body, "professionals"), false);
  }
});
