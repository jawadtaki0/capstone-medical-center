import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../api/public-assistant.js";
import { createPublicAssistant } from "../server/public-assistant.js";
import { browserPublicRequest } from "../server/public-assistant-context.js";
import { containsPrivateAccountText } from "../server/public-assistant-account.js";

const today = "2026-11-25";
const saturday = "2026-11-28";
const previous = {
  lastIntent: "hours",
  service: "center",
  date: "2026-11-27",
  specialty: null,
  clinicianId: null,
};
const data = {
  today: () => today,
  readHours: async (date) => ({
    date,
    publicationStatus: "published",
    centerClosed: false,
    centerHours: {
      startTime: "08:00",
      endTime: date === saturday ? "13:00" : "17:00",
    },
    otherServices: [
      {
        id: "laboratory",
        startTime: "08:00",
        endTime: date === saturday ? "13:00" : "14:30",
      },
    ],
  }),
  readSessions: async (date) => [
    {
      date,
      professionalId: "doctor:fixture",
      sourceSessionId: "session:fixture",
      professionalName: "Dr. Fixture",
      specialty: "Dentistry",
      kind: "doctor",
      startTime: "09:00",
      endTime: "12:00",
    },
  ],
  matchIntent: async () => ({ band: "low", intents: [] }),
};
const call = async (handler, message, context = null, language = "en") => {
  const response = {
    statusCode: 200,
    setHeader() {},
    end(raw) {
      this.body = JSON.parse(raw);
    },
  };
  await handler(
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { language, message, context },
    },
    response,
  );
  return [response.statusCode, response.body];
};

for (const text of [
  "Can I see the printout for the swab a nurse took from me last week?",
  "بدي نسخة عن الورقة يلي طلعت بعد ما الممرضة سحبتلي دم",
  "Please show the attachment you sent after collecting my urine sample.",
])
  test(
    "indirect private acquisition stays off the public route: " + text,
    async () => {
      assert.equal(containsPrivateAccountText(text), true);
      let called = 0;
      const result = await call(
        api.assistantHandler(async () => {
          called++;
          return { kind: "library" };
        }),
        text,
      );
      assert.deepEqual(result, [400, {}]);
      assert.equal(called, 0);
    },
  );
for (const text of [
  "Which container should visitors use to collect the sample?",
  "وين فيني اعرف شو التحضير لفحص البول؟",
  "What are the hours for leaving a specimen at the Lab?",
])
  test("public service question stays public: " + text, () =>
    assert.equal(containsPrivateAccountText(text), false),
  );

for (const [language, question, service] of [
  ["en", "Could we make it Saturday rather than Friday?", "center"],
  ["ar", "طيب السبت كيف بيكون الدوام؟", "center"],
  ["en", "Could you check the laboratory for that date as well?", "laboratory"],
  ["ar", "وكمان المختبر بهداك النهار لو سمحت؟", "laboratory"],
])
  test("structured refinement: " + question, async () => {
    const handle = api.assistantHandler(
      createPublicAssistant({ ...data, demo: true }),
    );
    const context =
      service === "center" ? previous : { ...previous, date: saturday };
    const [status, result] = await call(
      handle,
      browserPublicRequest(question, context, today),
      context,
      language,
    );
    assert.equal(status, 200);
    assert.match(result.text, /2026-11-28.*08:00.*13:00/u);
    assert.equal(result.context.service, service);
    assert.deepEqual(result.cards ?? [], []);
  });
test("short schedule refinement retains the last published clinician", async () => {
  const handle = api.assistantHandler(
    createPublicAssistant({ ...data, demo: true }),
  );
  const context = {
    lastIntent: "schedule",
    service: "clinic",
    date: "2026-11-27",
    specialty: "Dentistry",
    clinicianId: "doctor:fixture",
  };
  const [, result] = await call(
    handle,
    browserPublicRequest("Could we make it Saturday instead?", context, today),
    context,
  );
  assert.equal(result.kind, "sessions");
  assert.deepEqual(
    result.cards.map((card) => [card.date, card.start, card.end]),
    [[saturday, "09:00", "12:00"]],
  );
});

const environment = {
  VERCEL: "1",
  CEDAR_ASSISTANT_CONTEXT_KEY: Buffer.alloc(32, 57).toString("base64url"),
};
test("hosted signing configuration fails closed for absent or malformed key", async () => {
  for (const key of [undefined, "short"]) {
    const handler = api.createHostedAssistant({
      ...data,
      environment: { VERCEL: "1", CEDAR_ASSISTANT_CONTEXT_KEY: key },
    });
    assert.deepEqual(await call(handler, { topic: "urgent" }), [503, {}]);
  }
});
test("hosted guided control works across instances and expires", async () => {
  let at = 100000;
  const issuer = api.createHostedAssistant({
    ...data,
    environment,
    now: () => at,
  });
  const redeemer = api.createHostedAssistant({
    ...data,
    environment,
    now: () => at,
  });
  const [, issued] = await call(
    issuer,
    browserPublicRequest(
      "Show published Dentistry sessions on November 30, 2025",
      null,
      today,
    ),
  );
  assert.equal(issued.kind, "dateOptions");
  assert.ok(issued.dateOptions.includes(saturday));
  const request = { action: issued.dateAction, date: saturday };
  const [, result] = await call(redeemer, request);
  assert.equal(result.kind, "sessions");
  assert.equal(result.cards[0].date, saturday);
  const other = api.createHostedAssistant({
    ...data,
    environment: {
      ...environment,
      CEDAR_ASSISTANT_CONTEXT_KEY: Buffer.alloc(32, 58).toString("base64url"),
    },
    now: () => at,
  });
  for (const [handler, message] of [
    [other, request],
    [redeemer, { ...request, date: "2027-01-15" }],
  ]) {
    const [, invalid] = await call(handler, message);
    assert.equal(invalid.kind, "reception");
    assert.deepEqual(invalid.cards ?? [], []);
  }
  at += 600000;
  const [, expired] = await call(redeemer, request);
  assert.equal(expired.kind, "reception");
  assert.deepEqual(expired.cards ?? [], []);
});
