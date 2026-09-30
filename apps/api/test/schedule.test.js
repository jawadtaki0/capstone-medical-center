import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { getBeirutToday, getScheduleForDate, isValidScheduleDate } from "../src/schedule.js";
import { buildScheduleSeed, WEEKLY_SCHEDULE_ID } from "../src/schedule-seed-data.js";
import { CENTER_ID, COLLECTIONS } from "../src/schedule-model.js";
import { LEGACY_COLLECTION, LEGACY_SCHEDULE_IDS } from "../src/legacy-schedule-records.js";
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
          calls.push({ name, operation: "read" });
          return structuredClone(selected(name, query, options.sort)[0] ?? null);
        },
        find(query) {
          return { async toArray() {
            calls.push({ name, operation: "read" });
            return structuredClone(selected(name, query));
          } };
        },
        async createIndex() { calls.push({ name, operation: "index" }); },
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
    ["Zeinab Makahhel", "09:30", "13:00"], ["Maya Najdi", "09:30", "13:00"],
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
  assert.deepEqual(await requiredNames("2026-10-03"), ["Dr. Hasan Ezzeddine", "Maya Najdi", "Zeinab Makahhel"]);
  assert.deepEqual(await requiredNames("2026-09-30"), []);
  assert.deepEqual(await requiredNames("2026-09-28"), []);
});

test("completed seed reruns preserve admin edits, removals and published changes", async () => {
  const db = await seededDatabase();
  const profile = db.records(COLLECTIONS.doctors).get("cedar:doctor:hasan-rahal");
  profile.specialty = "Synthetic edited specialty";
  db.records(COLLECTIONS.specialists).delete("cedar:specialist:maya-najdi");
  db.records(COLLECTIONS.weekly).get(WEEKLY_SCHEDULE_ID).days[1].centerHours.endTime = "16:00";
  const before = db.calls.length;
  const result = await seedPublicSchedules(db);
  assert.equal(result.inserted, 0);
  assert.equal(result.status, "already_completed");
  assert.equal(profile.specialty, "Synthetic edited specialty");
  assert.equal(db.records(COLLECTIONS.specialists).has("cedar:specialist:maya-najdi"), false);
  assert.equal(db.records(COLLECTIONS.weekly).get(WEEKLY_SCHEDULE_ID).days[1].centerHours.endTime, "16:00");
  assert.equal(db.calls.slice(before).some(({ operation }) => operation !== "read"), false);
});

test("an interrupted first seed resumes without overwriting existing profiles", async () => {
  const db = memoryDatabase();
  db.put(COLLECTIONS.doctors, { ...buildScheduleSeed().doctors[0], specialty: "Synthetic retained edit" });
  const result = await seedPublicSchedules(db);
  assert.equal(result.inserted, 19);
  assert.equal(db.records(COLLECTIONS.doctors).get("cedar:doctor:hasan-ezzeddine").specialty, "Synthetic retained edit");
  assert.equal(db.records(COLLECTIONS.weekly).size, 1);
});

test("the exact old records are identified, preserved, and never read by the live resolver", async () => {
  const db = memoryDatabase();
  for (const _id of LEGACY_SCHEDULE_IDS) db.put(LEGACY_COLLECTION, { _id, doctorName: "Synthetic legacy record" });
  db.put(LEGACY_COLLECTION, { _id: "unrelated-record", doctorName: "Synthetic unrelated record" });
  const before = structuredClone([...db.records(LEGACY_COLLECTION).values()]);
  const result = await seedPublicSchedules(db);
  assert.equal(result.legacyIds.length, 12);
  assert.deepEqual([...db.records(LEGACY_COLLECTION).values()], before);
  db.calls.length = 0;
  const schedule = await getScheduleForDate("2026-09-07", db);
  assert.equal(schedule.doctorSessions.length, 3);
  assert.equal(db.calls.some(({ name }) => name === LEGACY_COLLECTION), false);
  assert.equal(db.calls.some(({ operation }) => operation !== "read"), false);
});

test("published one-date changes support cancellation, time changes, additions and services", async () => {
  const db = await seededDatabase();
  const day = structuredClone(buildScheduleSeed().weeklySchedule.days[3]);
  day.doctorSessions[0].status = "cancelled";
  day.doctorSessions[1].startTime = "10:30";
  day.centerHours.endTime = "16:00";
  day.otherServices[1].status = "cancelled";
  db.put(COLLECTIONS.doctors, {
    _id: "synthetic-doctor", centerId: CENTER_ID, name: "Dr. Synthetic Test",
    specialty: "Synthetic test specialty", publicationStatus: "published", active: true,
  });
  day.doctorSessions.push({
    id: "synthetic-added-session", doctorId: "synthetic-doctor", startTime: "14:00",
    endTime: "15:00", status: "active", appointmentRequired: true,
  });
  db.put(COLLECTIONS.changes, {
    _id: "synthetic-date-change", centerId: CENTER_ID, weeklyScheduleId: WEEKLY_SCHEDULE_ID,
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
    _id: "synthetic-draft-change", centerId: CENTER_ID, weeklyScheduleId: revision._id,
    date: "2026-10-05", publicationStatus: "draft", day: buildScheduleSeed().weeklySchedule.days[0],
  });
  db.put(COLLECTIONS.changes, {
    _id: "synthetic-stale-change", centerId: CENTER_ID, weeklyScheduleId: WEEKLY_SCHEDULE_ID,
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
  db.records(COLLECTIONS.doctors).delete("cedar:doctor:hasan-ezzeddine");
  await assert.rejects(getScheduleForDate("2026-09-30", db), /unavailable profile/);
  const response = await apiResponse(context, "/api/schedule?date=2026-09-30", async () => { throw new Error("Synthetic test outage"); });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "schedule_unavailable");
});
