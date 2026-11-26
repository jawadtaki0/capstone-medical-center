import test from "node:test";
import assert from "node:assert/strict";
import { assistantHandler } from "../api/public-assistant.js";
import { createPublicAssistant } from "../server/public-assistant.js";
import { privateAccountIntent } from "../server/public-assistant-account.js";
import { browserPublicRequest } from "../server/public-assistant-context.js";

const date = "2026-12-05";
const prior = {
  lastIntent: "hours",
  service: "laboratory",
  date,
  specialty: null,
  clinicianId: null,
};
const firstQuestion = "What hours does the Lab publish for December 5?";
const handler = () =>
  assistantHandler(
    createPublicAssistant({
      demo: true,
      today: () => "2026-12-03",
      matchIntent: async () => ({ band: "low", intents: [] }),
      readSessions: async (d) =>
        d === date
          ? [
              {
                professionalId: "doctor:fixture",
                sourceSessionId: "session:fixture",
                professionalName: "Dr. Example",
                specialty: "Dentistry",
                date: d,
                startTime: "09:30",
                endTime: "10:30",
                kind: "doctor",
                published: true,
                available: true,
              },
            ]
          : [],
      readHours: async (d) => ({
        date: d,
        publicationStatus: "published",
        centerClosed: false,
        centerHours: { startTime: "08:00", endTime: "17:00" },
        otherServices: [
          {
            id: "laboratory",
            startTime: "07:30",
            endTime: d === date ? "13:00" : "15:00",
          },
          {
            id: "audiometry",
            startTime: "09:00",
            endTime: d === date ? "12:00" : "16:00",
          },
        ],
      }),
    }),
  );
const invoke = async (handle, body, headers = {}) => {
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      this.body = JSON.parse(text);
    },
  };
  await handle(
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
    res,
  );
  return { status: res.statusCode, body: res.body };
};
// The browser turns typed text into public fields before anything is sent.
const turn = (message, context = null, language = "en") => ({
  message:
    typeof message === "string"
      ? browserPublicRequest(message, context, "2026-12-03")
      : message,
  context,
  language,
});

for (const extra of [
  { messages: ["Previous text"] },
  { history: ["Previous text"] },
  { searchContext: "synthetic-context" },
  { context: { ...prior, previousText: "Previous text" } },
  { context: { ...prior, date: "2026-02-30" } },
  { context: { ...prior, service: "prior free text" } },
])
  test(
    "rejects invalid or history fields before routing " + JSON.stringify(extra),
    async () => {
      let called = 0;
      const reply = await invoke(
        assistantHandler(async () => {
          called++;
          return { kind: "library" };
        }),
        { ...turn(firstQuestion), ...extra },
      );
      assert.equal(reply.status, 400);
      assert.equal(called, 0);
    },
  );
test("a public turn emits only structured context", async () => {
  const reply = await invoke(handler(), turn(firstQuestion));
  assert.equal(reply.status, 200);
  assert.match(reply.body.text, /2026-12-05.*07:30.*13:00/u);
  assert.deepEqual(reply.body.context, prior);
  assert.deepEqual(reply.body.cards ?? [], []);
});
for (const [language, message] of [
  ["en", "What about Audiometry hours on that same date?"],
  ["ar", "شو دوام فحوصات السمع بهالنهار؟"],
])
  test("Beirut service switch " + language, async () => {
    const reply = await invoke(handler(), turn(message, prior, language));
    assert.equal(reply.status, 200);
    assert.match(reply.body.text, /2026-12-05.*09:00.*12:00/u);
    assert.deepEqual(reply.body.cards ?? [], []);
    assert.equal(reply.body.context.service, "audiometry");
  });
test("Clinic specialty cards use the carried date", async () => {
  const reply = await invoke(
    handler(),
    turn("Show published Dentistry sessions on that same day", prior),
  );
  assert.equal(reply.status, 200);
  const [card] = reply.body.cards;
  assert.equal(card.date, date);
  assert.equal(card.start, "09:30");
  assert.equal(card.end, "10:30");
  assert.match(card.href, /professional=doctor%3Afixture/u);
  assert.equal(reply.body.context.clinicianId, "doctor:fixture");
});
test("same-service date follow-up has published weekday hours", async () => {
  const reply = await invoke(handler(), turn("And on Friday?", prior));
  assert.match(reply.body.text, /2026-12-04.*07:30.*15:00/u);
  assert.equal(reply.body.context.service, "laboratory");
});
test("a protected action clears date context", async () => {
  const handle = handler();
  const reply = await invoke(handle, turn({ topic: "urgent" }, prior));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.kind, "emergency");
  assert.equal(reply.body.context, null);
  const follow = await invoke(
    handle,
    turn("What are Lab hours on that same day?", reply.body.context),
  );
  assert.doesNotMatch(follow.body.text, /\d{4}-\d{2}-\d{2}.*07:30/u);
});
test("a stale date cannot supply the day in the question", async () => {
  const reply = await invoke(
    handler(),
    turn("What hours does the Lab have on that same date?", {
      ...prior,
      date: "2026-11-25",
    }),
  );
  assert.equal(reply.status, 200);
  assert.doesNotMatch(reply.body.text, /\d{4}-\d{2}-\d{2}.*07:30/u);
  assert.equal(reply.body.context, null);
});
for (const [question, intent] of [
  ["وين فيني راجع المواعيد اللي واخدها أنا؟", "my_bookings"],
  ["شو أخبار حجوزاتنا عندكن؟", "booking_status"],
  ["فرجيني الفحوصات يلي وصلتني من المختبر", "my_results"],
])
  test("personal Arabic phrasing " + question, () =>
    assert.equal(privateAccountIntent(question), intent),
  );
