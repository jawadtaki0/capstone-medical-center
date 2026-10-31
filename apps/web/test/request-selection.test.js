import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarYear,
  selectionKey,
  validatedPreselection,
  preselectionDate,
  createCatalogueLoader,
  validatedProfessionalPreselection,
  requestSelectionUrl,
} from "../src/request-selection.js";

test("professional links and dated links are hints validated only against published IDs", () => {
  const professionals = [{ id: "doctor:synthetic", name: "Synthetic" }];
  const url = requestSelectionUrl({ doctorId: professionals[0].id });
  assert.equal(
    validatedProfessionalPreselection(
      url.slice(url.indexOf("?")),
      professionals,
    ),
    professionals[0],
  );
  for (const search of [
    "?professional=missing",
    "?professional=doctor%3Asynthetic&professional=other",
    "?professional=doctor%3Asynthetic&phone=private",
  ])
    assert.equal(
      validatedProfessionalPreselection(search, professionals),
      null,
    );
  const session = {
    professionalId: professionals[0].id,
    id: "session:one",
    date: "2027-11-01",
  };
  const dated = requestSelectionUrl(session);
  assert.equal(
    validatedPreselection(dated.slice(dated.indexOf("?")), [session]),
    session,
  );
  assert.equal(requestSelectionUrl({}), "/request");
  assert.match(
    requestSelectionUrl({
      specialistId: "specialist:synthetic",
      id: "session:specialist",
      date: "2027-11-01",
    }),
    /professional=specialist%3Asynthetic/,
  );
});
test("dated links bind their actual window and reject changed hours or forged window parameters", () => {
  const s = {
    professionalId: "doctor",
    sourceSessionId: "weekly",
    date: "2027-11-01",
    startTime: "09:00",
    endTime: "11:00",
  };
  const query = requestSelectionUrl(s).split("?")[1];
  assert.equal(preselectionDate(query), s.date);
  assert.equal(validatedPreselection(query, [s]), s);
  assert.equal(
    validatedPreselection(query, [{ ...s, startTime: "10:00" }]),
    null,
  );
  assert.equal(validatedPreselection(query + "&start=09:00", [s]), null);
});
test("a changed attendance window creates a new submission identity while an uncertain unchanged retry keeps its original", () => {
  let calls = 0;
  const attempt = createSubmissionAttempt(() => String(++calls));
  const s = {
    professionalId: "one",
    sourceSessionId: "same",
    date: "2027-11-01",
    startTime: "09:00",
    endTime: "11:00",
  };
  const key = attempt({}, s, "");
  assert.equal(attempt({}, s, ""), key);
  assert.notEqual(attempt({}, { ...s, startTime: "10:00" }, ""), key);
});
import {
  createRequestClient,
  createSubmissionAttempt,
} from "../src/website-request-client.js";
const defer = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test("calendar year keeps partial/invalid input uncommitted and bounds DOB", () => {
  for (const draft of [
    "",
    "2",
    "20",
    "200",
    "0200",
    "20000",
    "20x0",
    "1899",
    "2030",
  ])
    assert.equal(calendarYear(draft, 2026), null);
  assert.equal(calendarYear("2000", 2026), 2000);
  assert.equal(calendarYear("1900", 2026), 1900);
  assert.equal(new Date(Date.UTC(calendarYear("2000"), 2, 0)).getUTCDate(), 29);
  assert.equal(new Date(Date.UTC(calendarYear("1900"), 2, 0)).getUTCDate(), 28);
});
test("catalogue emits loading, never successful empty before both responses", async () => {
  const sessions = defer(),
    professionals = defer(),
    states = [];
  const loader = createCatalogueLoader(
    (a) =>
      a.startsWith("sessions") ? sessions.promise : professionals.promise,
    (s) => states.push(s),
  );
  const pending = loader.load("2026-11-02");
  assert.deepEqual(states, [{ status: "loading", date: "2026-11-02" }]);
  sessions.resolve([]);
  await Promise.resolve();
  assert.equal(states.length, 1);
  professionals.resolve([]);
  await pending;
  assert.equal(states.at(-1).status, "ready");
  assert.deepEqual(states.at(-1).sessions, []);
});
test("late catalogue success or failure cannot replace a newer date", async () => {
  for (const fail of [false, true]) {
    const old = defer(),
      states = [];
    const loader = createCatalogueLoader(
      (a) => (a.includes("11-02") ? old.promise : Promise.resolve([])),
      (s) => states.push(s),
    );
    const pending = loader.load("2026-11-02");
    await loader.load("2026-11-03");
    fail ? old.reject(Error("offline")) : old.resolve([{ id: "obsolete" }]);
    await pending;
    assert.equal(states.at(-1).date, "2026-11-03");
    assert.equal(states.at(-1).status, "ready");
  }
});
test("catalogue failures stay failures; cancellation discards delayed results", async () => {
  const states = [],
    delayed = defer();
  const loader = createCatalogueLoader(
    () => delayed.promise,
    (s) => states.push(s),
  );
  const pending = loader.load("2026-11-02");
  loader.cancel();
  delayed.resolve([]);
  await pending;
  assert.equal(states.length, 1);
  const failed = createCatalogueLoader(
    async () => {
      throw Error("waking");
    },
    (s) => states.push(s),
  );
  await failed.load("2026-11-03");
  assert.equal(states.at(-1).status, "unavailable");
  assert.equal(Object.hasOwn(states.at(-1), "sessions"), false);
});
test("preselection uses only exact validated catalogue IDs/date, never display text", () => {
  const s = {
    professionalId: "prof:one",
    date: "2026-11-02",
    sourceSessionId: "session:one",
  };
  assert.equal(
    validatedPreselection(
      "?professional=prof%3Aone&date=2026-11-02&session=session%3Aone",
      [s],
    ),
    s,
  );
  for (const q of [
    "?professional=Dr+One&date=2026-11-02&session=session%3Aone",
    "?professional=prof%3Aone&date=2026-11-03&session=session%3Aone",
    "?professional=prof%3Aone&professional=other&date=2026-11-02&session=session%3Aone",
    "?professional=prof%3Aone&date=2026-11-02&session=session%3Aone&token=forged",
  ])
    assert.equal(validatedPreselection(q, [s]), null);
  assert.notEqual(selectionKey(s), selectionKey({ ...s, date: "2026-11-03" }));
  assert.equal(
    preselectionDate("?professional=one&date=2026-11-04&session=weekly"),
    "2026-11-04",
  );
  assert.equal(
    preselectionDate("?professional=one&date=2026-02-30&session=weekly"),
    null,
  );
});
test("definitive ended-session refusal is not mislabeled as uncertain network failure", async () => {
  const api = createRequestClient({
    request: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "session_unavailable",
            message: "This attendance window has ended.",
          },
        }),
        { status: 400 },
      ),
  });
  await assert.rejects(api("submit", {}), {
    code: "session_unavailable",
    status: 400,
    message: "This attendance window has ended.",
  });
});
test("uncertain submission keeps exact retry identity and recovers same receipt", async () => {
  let keys = 0;
  const attempt = createSubmissionAttempt(() => `key-${++keys}`),
    calls = [];
  const api = createRequestClient({
    request: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) throw new TypeError("network");
      return new Response(
        JSON.stringify({
          reference: "WR-DUMMY",
          trackingToken: "A".repeat(43),
        }),
      );
    },
  });
  const patient = { firstName: "Synthetic" },
    session = {
      professionalId: "one",
      sourceSessionId: "weekly",
      date: "2026-11-02",
    };
  const send = () =>
    api("submit", {
      submissionKey: attempt(patient, session),
      patient,
      selection: session,
    });
  await assert.rejects(
    send(),
    (e) =>
      e.code === "request_unavailable" && e.message.includes("may already"),
  );
  assert.equal((await send()).reference, "WR-DUMMY");
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(keys, 1);
});
test("upcoming action stays fixed-origin, paginated and credential-free", async () => {
  let called;
  const api = createRequestClient({
    request: async (...args) => {
      called = args;
      return new Response(
        JSON.stringify({
          sessions: [],
          fromDate: "2026-11-02",
          throughDate: "2026-11-29",
          nextDate: "2026-11-30",
          nextAfter: null,
        }),
      );
    },
  });
  assert.equal(
    (await api("upcoming?professionalId=prof%3Aone&fromDate=2026-11-02"))
      .nextDate,
    "2026-11-30",
  );
  assert.equal(
    called[0],
    "/api/requests/upcoming?professionalId=prof%3Aone&fromDate=2026-11-02",
  );
  assert.equal(called[1].credentials, "omit");
  assert.equal(called[1].redirect, "error");
});
