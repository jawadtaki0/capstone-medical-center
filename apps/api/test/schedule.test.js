import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { getBeirutToday, getScheduleForDate, isValidScheduleDate } from "../src/schedule.js";
import { buildScheduleSeed, SEED_ID, WEEKLY_SCHEDULE_ID } from "../src/schedule-seed-data.js";
import { COLLECTIONS } from "../src/schedule-model.js";
import { seedPublicSchedules } from "../src/seed-schedule.js";

function memoryDatabase() {
  const collections = new Map();
  const calls = [];
  function records(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function matches(document, query) {
    return Object.entries(query).every(([key, expected]) => {
      if (key === "$or") return expected.some((condition) => matches(document, condition));
      const actual = document[key];
      if (expected && typeof expected === "object") {
        if ("$in" in expected) return expected.$in.includes(actual);
        if ("$lte" in expected) return typeof actual === "string" && actual <= expected.$lte;
        throw new Error("Unsupported test query");
      }
      return expected === null ? actual == null : actual === expected;
    });
  }
  function selected(name, query, sort = {}) {
    return [...records(name).values()].filter((item) => matches(item, query)).sort((a, b) => {
      for (const [key, direction] of Object.entries(sort)) {
        if (a[key] === b[key]) continue;
        if (a[key] == null) return -direction;
        if (b[key] == null) return direction;
        return (a[key] < b[key] ? -1 : 1) * direction;
      }
      return 0;
    });
  }
  return {
    calls, records,
    put(name, document) { records(name).set(document._id, structuredClone(document)); },
    collection(name) {
      return {
        async findOne(query, options = {}) {
          calls.push({ name, operation: "read", query, options });
          return structuredClone(selected(name, query, options.sort)[0] ?? null);
        },
        find(query, options = {}) {
          return { async toArray() {
            calls.push({ name, operation: "read", query, options });
            return structuredClone(selected(name, query));
          } };
        },
        async createIndex(keys) { calls.push({ name, operation: "index", keys }); },
        async updateOne({ _id }, update, options) {
          calls.push({ name, operation: "write" });
          assert.deepEqual(options, { upsert: true });
          assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
          if (records(name).has(_id)) return { upsertedCount: 0 };
          records(name).set(_id, structuredClone(update.$setOnInsert));
          return { upsertedCount: 1 };
        },
      };
    },
  };
}

async function seededDatabase() {
  const db = memoryDatabase();
  await seedPublicSchedules(db);
  return db;
}

test("initialization uses neutral IDs, confirmed genders, current wording and the agreed schema", () => {
  const timestamp = "2026-10-01T09:00:00.000Z";
  const seed = buildScheduleSeed(timestamp);
  assert.equal(SEED_ID, "approved-weekly-v1");
  assert.equal(WEEKLY_SCHEDULE_ID, "weekly:approved-v1");
  const profiles = [...seed.doctors, ...seed.specialists];
  const femaleIds = [
    "doctor:diana-sharafeddin", "doctor:narjes-fadlallah", "doctor:rola-reslan",
    "doctor:zahraa-badawi", "doctor:sawsan-el-korsifi", "specialist:taghreed-doueibes",
    "specialist:maya-najdi", "specialist:zeinab-makahhel",
  ];
  assert.equal(profiles.length, 19);
  assert.equal(profiles.filter(({ gender }) => gender === "male").length, 11);
  assert.deepEqual(profiles.filter(({ gender }) => gender === "female").map(({ _id }) => _id).sort(), femaleIds.sort());
  for (const profile of profiles) {
    assert.deepEqual(Object.keys(profile).sort(), ["_id", "active", "gender", "name", "specialty"]);
    assert.match(profile._id, /^(doctor|specialist):/);
    assert.equal(profile.active, true);
  }
  assert.equal(seed.specialists.find(({ _id }) => _id === "specialist:maya-najdi").specialty, "Therapist");
  assert.equal(seed.specialists.find(({ _id }) => _id === "specialist:zeinab-makahhel").name, "Zeinab Mkahhel");
  assert.deepEqual(Object.keys(seed.weeklySchedule).sort(), ["_id", "days", "effectiveFrom", "publicationStatus", "publishedAt"]);
  assert.equal(seed.weeklySchedule.effectiveFrom, null);
  assert.equal(seed.weeklySchedule.publishedAt, timestamp);
  assert.deepEqual(Object.keys(seed.weeklySchedule.days), ["0", "1", "2", "3", "4", "5", "6"]);
  const doctorIds = new Set(seed.doctors.map(({ _id }) => _id));
  const specialistIds = new Set(seed.specialists.map(({ _id }) => _id));
  for (const day of Object.values(seed.weeklySchedule.days)) {
    for (const session of day.doctorSessions) assert.equal(doctorIds.has(session.doctorId), true);
    for (const session of day.specialistSessions) assert.equal(specialistIds.has(session.specialistId), true);
    for (const session of [...day.doctorSessions, ...day.specialistSessions]) assert.equal(session.id.startsWith("cedar:"), false);
  }
});

test("completed neutral seed marker preserves its timestamp and prevents all writes", async () => {
  const db = memoryDatabase();
  const marker = { _id: SEED_ID, completedAt: "2026-09-30T15:00:00.000Z" };
  db.put(COLLECTIONS.seeds, marker);
  assert.deepEqual(await seedPublicSchedules(db), { inserted: 0, status: "already_completed" });
  assert.deepEqual(db.records(COLLECTIONS.seeds).get(SEED_ID), marker);
  assert.equal(db.records(COLLECTIONS.doctors).size, 0);
  assert.equal(db.calls.some(({ operation }) => operation !== "read"), false);
});

test("old completion marker or profile data requires migration before seed writes", async () => {
  for (const [collection, document] of [
    [COLLECTIONS.seeds, { _id: `cedar:${SEED_ID}`, completedAt: "2026-09-30T15:00:00.000Z" }],
    [COLLECTIONS.doctors, { _id: "cedar:doctor:hasan-rahal", name: "Synthetic retained profile" }],
    [COLLECTIONS.weekly, { _id: `cedar:${WEEKLY_SCHEDULE_ID}` }],
  ]) {
    const db = memoryDatabase();
    db.put(collection, document);
    await assert.rejects(seedPublicSchedules(db), /must be migrated/);
    assert.deepEqual(db.records(collection).get(document._id), document);
    assert.equal(db.calls.some(({ operation }) => operation !== "read"), false);
  }
});

test("initialization creates neutral schedule indexes, never profile publication indexes", async () => {
  const db = await seededDatabase();
  assert.deepEqual(db.calls.filter(({ operation }) => operation === "index").map(({ name, keys }) => [name, keys]), [
    [COLLECTIONS.weekly, { publicationStatus: 1, effectiveFrom: -1, publishedAt: -1 }],
    [COLLECTIONS.changes, { weeklyScheduleId: 1, date: 1, publicationStatus: 1, publishedAt: -1 }],
  ]);
});

test("weekly sessions recur until another publication takes effect", async () => {
  const db = await seededDatabase();
  const expectedDoctors = [3, 5, 5, 5, 8, 2, 0];
  const expectedSpecialists = [1, 0, 1, 1, 1, 2, 0];
  const dates = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  for (let offset = 0; offset < 7; offset += 1) {
    const first = await getScheduleForDate(dates[offset], db);
    const nextDate = new Date(`${first.date}T12:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 7);
    const next = await getScheduleForDate(nextDate.toISOString().slice(0, 10), db);
    const withoutDates = (items) => items.map(({ date, ...item }) => item);
    assert.deepEqual(withoutDates(first.doctorSessions), withoutDates(next.doctorSessions));
    assert.deepEqual(withoutDates(first.specialistSessions), withoutDates(next.specialistSessions));
    assert.equal(first.doctorSessions.length, expectedDoctors[offset]);
    assert.equal(first.specialistSessions.length, expectedSpecialists[offset]);
    assert.equal(first.publicationStatus, "published");
    assert.equal(first.timeZone, "Asia/Beirut");
  }
});

test("corrected profiles and session times come from the approved schedule", async () => {
  const db = await seededDatabase();
  const monday = await getScheduleForDate("2026-09-28", db);
  const friday = await getScheduleForDate("2026-10-02", db);
  const surgeon = (schedule) => schedule.doctorSessions.find(({ doctorName }) => doctorName === "Dr. Issam Al-Tawil");
  assert.deepEqual([surgeon(monday).startTime, surgeon(monday).endTime], ["11:00", "12:00"]);
  assert.deepEqual([surgeon(friday).startTime, surgeon(friday).endTime], ["10:00", "11:00"]);
  assert.equal(db.records(COLLECTIONS.doctors).size, 16);
  assert.equal(db.records(COLLECTIONS.specialists).size, 3);
  const tuesday = await getScheduleForDate("2026-09-29", db);
  const urologist = tuesday.doctorSessions.find(({ doctorName }) => doctorName === "Dr. Hasan Abou Zaid");
  assert.deepEqual([urologist.startTime, urologist.endTime], ["09:00", "11:00"]);
  assert.equal(friday.otherServices.find(({ id }) => id === "audiometry").startTime, "09:00");
  for (const date of ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]) {
    const schedule = await getScheduleForDate(date, db);
    assert.deepEqual(schedule.centerHours, { startTime: "08:00", endTime: "17:00" });
    assert.deepEqual(schedule.otherServices.map(({ startTime, endTime }) => [startTime, endTime]), [["08:00", "14:30"], ["09:00", "14:30"]]);
    for (const session of [...schedule.doctorSessions, ...schedule.specialistSessions]) {
      assert.equal(Object.hasOwn(session, "capacity"), false);
      assert.equal(/[\u0600-\u06ff]/.test(session.doctorName ?? session.name), false);
    }
  }
});

test("Saturday has its own hours and both 09:30–13:00 therapy sessions", async () => {
  const schedule = await getScheduleForDate("2026-10-03", await seededDatabase());
  assert.deepEqual(schedule.centerHours, { startTime: "08:00", endTime: "13:00" });
  assert.deepEqual(schedule.otherServices.map(({ startTime, endTime }) => [startTime, endTime]), [["08:00", "13:00"], ["09:00", "13:00"]]);
  assert.deepEqual(schedule.specialistSessions.map(({ name, startTime, endTime }) => [name, startTime, endTime]), [
    ["Zeinab Mkahhel", "09:30", "13:00"], ["Maya Najdi", "09:30", "13:00"],
  ]);
});

test("Sunday is explicitly closed and has no service hours or sessions", async () => {
  const schedule = await getScheduleForDate("2026-10-04", await seededDatabase());
  assert.equal(schedule.centerClosed, true);
  assert.equal(schedule.centerHours, null);
  assert.deepEqual(schedule.doctorSessions, []);
  assert.deepEqual(schedule.specialistSessions, []);
  assert.deepEqual(schedule.otherServices, []);
});

test("no-walk-in flags require an appointment without blocking advance booking", async () => {
  const db = await seededDatabase();
  const requiredNames = async (date) => {
    const schedule = await getScheduleForDate(date, db);
    return [...schedule.doctorSessions, ...schedule.specialistSessions]
      .filter(({ appointmentRequired }) => appointmentRequired)
      .map((session) => session.doctorName ?? session.name).sort();
  };
  assert.deepEqual(await requiredNames("2026-10-01"), ["Dr. Narjes Fadlallah", "Taghreed Doueibes"]);
  assert.deepEqual(await requiredNames("2026-10-02"), ["Dr. Ezzat Hashem", "Dr. Issam Al-Tawil", "Dr. Sawsan El-Korsifi", "Dr. Soleiman Jibawi"]);
  assert.deepEqual(await requiredNames("2026-10-03"), ["Dr. Hasan Ezzeddine", "Maya Najdi", "Zeinab Mkahhel"]);
  assert.deepEqual(await requiredNames("2026-09-30"), []);
  assert.deepEqual(await requiredNames("2026-09-28"), []);
});

test("completed seed reruns preserve admin edits, removals and published changes", async () => {
  const db = await seededDatabase();
  const profile = db.records(COLLECTIONS.doctors).get("doctor:hasan-rahal");
  profile.specialty = "Synthetic edited specialty";
  db.records(COLLECTIONS.specialists).delete("specialist:maya-najdi");
  db.records(COLLECTIONS.weekly).get(WEEKLY_SCHEDULE_ID).days[1].centerHours.endTime = "16:00";
  const before = db.calls.length;
  const result = await seedPublicSchedules(db);
  assert.equal(result.inserted, 0);
  assert.equal(result.status, "already_completed");
  assert.equal(profile.specialty, "Synthetic edited specialty");
  assert.equal(db.records(COLLECTIONS.specialists).has("specialist:maya-najdi"), false);
  assert.equal(db.records(COLLECTIONS.weekly).get(WEEKLY_SCHEDULE_ID).days[1].centerHours.endTime, "16:00");
  assert.equal(db.calls.slice(before).some(({ operation }) => operation !== "read"), false);
});

test("an interrupted first seed resumes without overwriting existing profiles", async () => {
  const db = memoryDatabase();
  db.put(COLLECTIONS.doctors, { ...buildScheduleSeed().doctors[0], specialty: "Synthetic retained edit" });
  const result = await seedPublicSchedules(db);
  assert.equal(result.inserted, 19);
  assert.equal(db.records(COLLECTIONS.doctors).get("doctor:hasan-ezzeddine").specialty, "Synthetic retained edit");
  assert.equal(db.records(COLLECTIONS.weekly).size, 1);
});

test("obsolete announcements are never queried by the seed or live resolver", async () => {
  const db = memoryDatabase();
  const legacyCollection = "public_schedule_days";
  db.put(legacyCollection, { _id: "synthetic-old-day", doctorName: "Synthetic legacy record" });
  const before = structuredClone([...db.records(legacyCollection).values()]);
  await seedPublicSchedules(db);
  const schedule = await getScheduleForDate("2026-09-07", db);
  assert.equal(schedule.doctorSessions.length, 3);
  assert.equal(db.calls.some(({ name }) => name === legacyCollection), false);
  assert.deepEqual([...db.records(legacyCollection).values()], before);
});

test("published one-date changes support cancellation, time changes, additions and services", async () => {
  const db = await seededDatabase();
  const day = structuredClone(buildScheduleSeed().weeklySchedule.days[3]);
  day.doctorSessions[0].status = "cancelled";
  day.doctorSessions[1].startTime = "10:30";
  day.centerHours.endTime = "16:00";
  day.otherServices[1].status = "cancelled";
  db.put(COLLECTIONS.doctors, {
    _id: "doctor:synthetic", name: "Dr. Synthetic Test",
    specialty: "Synthetic test specialty", active: true, gender: "male",
  });
  day.doctorSessions.push({
    id: "synthetic-added-session", doctorId: "doctor:synthetic", startTime: "14:00",
    endTime: "15:00", status: "active", appointmentRequired: true,
  });
  db.put(COLLECTIONS.changes, {
    _id: "synthetic-date-change", weeklyScheduleId: WEEKLY_SCHEDULE_ID,
    date: "2026-09-30", publicationStatus: "published", publishedAt: "2026-09-29T10:00:00Z", day,
  });
  const changed = await getScheduleForDate("2026-09-30", db);
  const next = await getScheduleForDate("2026-10-07", db);
  assert.equal(changed.doctorSessions.find(({ doctorName }) => doctorName === "Dr. Hasan Ezzeddine").status, "cancelled");
  assert.equal(changed.doctorSessions.find(({ doctorName }) => doctorName === "Dr. Mohammad Rizk").startTime, "10:30");
  assert.equal(changed.doctorSessions.some(({ doctorName }) => doctorName === "Dr. Synthetic Test"), true);
  assert.deepEqual(changed.otherServices.map(({ id }) => id), ["laboratory"]);
  assert.equal(next.doctorSessions.length, 5);
  assert.equal(next.doctorSessions[0].status, "active");
  assert.equal(next.centerHours.endTime, "17:00");
});

test("future weekly publications take effect on their date and drafts stay hidden", async () => {
  const db = await seededDatabase();
  const revision = structuredClone(buildScheduleSeed().weeklySchedule);
  revision._id = "synthetic-future-revision";
  revision.effectiveFrom = "2026-10-05";
  revision.publishedAt = "2026-09-30T10:00:00Z";
  revision.days[1].doctorSessions.find(({ doctorId }) => doctorId.endsWith("issam-al-tawil")).startTime = "11:30";
  db.put(COLLECTIONS.weekly, revision);
  db.put(COLLECTIONS.weekly, { ...revision, _id: "synthetic-draft", publicationStatus: "draft", effectiveFrom: "2026-10-12" });
  db.put(COLLECTIONS.changes, {
    _id: "synthetic-draft-change", weeklyScheduleId: revision._id,
    date: "2026-10-05", publicationStatus: "draft", day: buildScheduleSeed().weeklySchedule.days[0],
  });
  db.put(COLLECTIONS.changes, {
    _id: "synthetic-stale-change", weeklyScheduleId: WEEKLY_SCHEDULE_ID,
    date: "2026-10-05", publicationStatus: "published", day: buildScheduleSeed().weeklySchedule.days[0],
  });
  const surgeonStart = async (date) => (await getScheduleForDate(date, db)).doctorSessions.find(({ doctorName }) => doctorName === "Dr. Issam Al-Tawil").startTime;
  assert.equal(await surgeonStart("2026-09-28"), "11:00");
  assert.equal(await surgeonStart("2026-10-05"), "11:30");
  assert.equal(await surgeonStart("2026-10-12"), "11:30");
});

test("unpublished dates and invalid dates never seed the database", async () => {
  const db = memoryDatabase();
  const missing = await getScheduleForDate("2026-09-30", db);
  assert.equal(missing.publicationStatus, "unpublished");
  assert.equal(missing.centerClosed, null);
  for (const value of ["2026-02-30", "2026-13-01", "09/29/2026", "", "2026-9-29"]) {
    assert.equal(isValidScheduleDate(value), false);
    await assert.rejects(getScheduleForDate(value, db), RangeError);
  }
  assert.equal(db.calls.some(({ operation }) => operation !== "read"), false);
});

test("Beirut today's date follows Beirut midnight across month/year boundaries", () => {
  assert.equal(getBeirutToday(new Date("2026-09-29T22:30:00Z")), "2026-09-30");
  assert.equal(getBeirutToday(new Date("2026-12-31T22:30:00Z")), "2027-01-01");
});

async function apiResponse(context, path, scheduleReader, method = "GET") {
  const server = createApp({ scheduleReader }).listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
  return { status: response.status, body: await response.json() };
}

test("API returns the same database-backed schedule for default and explicit today", async (context) => {
  const db = await seededDatabase();
  const reader = (date) => getScheduleForDate(date, db);
  const defaultDay = await apiResponse(context, "/api/schedule", reader);
  const explicitDay = await apiResponse(context, `/api/schedule?date=${getBeirutToday()}`, reader);
  assert.equal(defaultDay.status, 200);
  assert.deepEqual(defaultDay.body, explicitDay.body);
  assert.equal(defaultDay.body.publicationStatus, "published");
});

test("API rejects invalid dates and exposes no schedule-writing endpoint", async (context) => {
  const reader = () => { throw new Error("should not read"); };
  const invalid = await apiResponse(context, "/api/schedule?date=2026-02-30", reader);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid_date");
  const write = await apiResponse(context, "/api/schedule", reader, "POST");
  assert.equal(write.status, 404);
});

test("database failures produce 503 and missing profiles do not silently hide sessions", async (context) => {
  const db = await seededDatabase();
  db.records(COLLECTIONS.doctors).delete("doctor:hasan-ezzeddine");
  await assert.rejects(getScheduleForDate("2026-09-30", db), /unavailable profile/);
  const response = await apiResponse(context, "/api/schedule?date=2026-09-30", async () => { throw new Error("Synthetic test outage"); });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "schedule_unavailable");
});

test("schedule profile lookup uses only active visibility and safe public fields", async () => {
  const db = await seededDatabase();
  db.calls.length = 0;
  const schedule = await getScheduleForDate("2026-09-30", db);
  assert.equal(schedule.doctorSessions.length, 5);
  assert.equal(schedule.specialistSessions.length, 1);
  const reads = db.calls.filter(({ name }) => [COLLECTIONS.doctors, COLLECTIONS.specialists].includes(name));
  for (const { query, options } of reads) {
    assert.deepEqual(Object.keys(query).sort(), ["_id", "active"]);
    assert.equal(query.active, true);
    assert.deepEqual(options.projection, { _id: 1, name: 1, specialty: 1 });
    assert.equal(query._id.$in.every((id) => !id.startsWith("cedar:")), true);
  }
  assert.equal(db.calls.some(({ operation }) => operation !== "read"), false);
  const profile = db.records(COLLECTIONS.doctors).get("doctor:hasan-ezzeddine");
  profile.active = false;
  await assert.rejects(getScheduleForDate("2026-09-30", db), /unavailable profile/);
});
