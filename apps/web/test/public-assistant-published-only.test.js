import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantHandler } from "../api/public-assistant.js";
import { createPublicAssistant } from "../server/public-assistant.js";
import { rulesCopy } from "../server/public-assistant-gate.js";
import {
  emergencyLine,
  receptionHandoff,
} from "../src/public-assistant-safety.js";

const today = "2026-11-25";
const friday = "2026-11-27";
const saturday = "2026-11-28";
const sunday = "2026-11-29";

function fixture() {
  const calls = [];
  const forbidden = async () => {
    calls.push("provider");
    throw Error("Provider must stay disabled");
  };
  const answer = createPublicAssistant({
    today: () => today,
    readHours: async (date) => {
      calls.push(["hours", date]);
      return {
        date,
        publicationStatus: "published",
        centerClosed: date === sunday,
        centerHours: { startTime: "08:00", endTime: "17:00" },
        otherServices: [
          {
            id: "laboratory",
            startTime: "08:00",
            endTime: date === saturday ? "12:30" : "14:30",
          },
          { id: "audiometry", startTime: "09:00", endTime: "14:00" },
        ],
      };
    },
    readSessions: async (date) => {
      calls.push(["sessions", date]);
      return date === friday
        ? [
            {
              date,
              professionalName: "Dr. Lina Mansour",
              professionalId: "lina",
              sourceSessionId: "fixture-session",
              specialty: "Dentistry",
              startTime: "10:00",
              endTime: "12:00",
            },
          ]
        : [];
    },
    interpret: forbidden,
    compose: forbidden,
  });
  return { answer, calls };
}

const normal = [
  [
    "en",
    "When does the Laboratory close on Saturday?",
    "library",
    /2026-11-28.*12:30|12:30.*2026-11-28/u,
    [],
    [["hours", saturday]],
  ],
  [
    "ar",
    "شو ساعات المختبر اليوم؟",
    "library",
    /2026-11-25.*08:00–14:30/u,
    [],
    [["hours", today]],
  ],
  [
    "ar",
    "Emta maftou7 l sama3 nhar l jem3a?",
    "library",
    /2026-11-27.*09:00–14:00/u,
    [],
    [["hours", friday]],
  ],
  [
    "ar",
    "هل المركز مفتوح الأحد؟",
    "library",
    /مغلق.*2026-11-29/u,
    [],
    [["hours", sunday]],
  ],
  [
    "en",
    "Is Dr. Lina Mansour available Friday?",
    "sessions",
    /published attendance windows/u,
    [[friday, "10:00", "12:00"]],
    [["sessions", friday]],
  ],
  [
    "ar",
    "في جلسات طب أسنان يوم الجمعة؟",
    "sessions",
    /مواعيد الحضور المنشورة/u,
    [[friday, "10:00", "12:00"]],
    [["sessions", friday]],
  ],
  [
    "en",
    "Are there Urology sessions Friday?",
    "empty",
    /couldn’t find.*urology.*2026-11-27/u,
    [],
    [["sessions", friday]],
  ],
  [
    "en",
    "How much does a CBC cost?",
    "reception",
    /not published prices.*Contact Reception/u,
    [],
    [],
  ],
  [
    "en",
    "Should I fast for an HbA1c?",
    "labs",
    /Fasting is not normally needed for HbA1c alone/u,
    [],
    [],
  ],
  [
    "ar",
    "شو طريقة جمع عيّنة لزراعة البول؟",
    "labs",
    /زرع البول.*طريقة الجمع.*الوعاء/u,
    [],
    [],
  ],
];

for (const [
  i,
  [language, message, kind, text, cards, reads],
] of normal.entries())
  test("published normal " + (i + 1), async (t) => {
    const { answer, calls } = fixture();
    const result = await answer({ language, messages: [message] });
    t.diagnostic(JSON.stringify({ language, message, result, calls }));
    assert.equal(result.kind, kind);
    assert.match(result.text, text);
    assert.deepEqual(
      (result.cards ?? []).map((c) => [c.date, c.start, c.end]),
      cards,
    );
    assert.equal(result.emergencyLine, emergencyLine[language]);
    assert.deepEqual(calls, reads);
  });

for (const [i, [language, message]] of [
  [
    "en",
    "What time does the lab open? Something awful happened and I need help.",
  ],
  ["en", "Can you help me use the parking pass while I get a CBC?"],
  ["ar", "دوام المختبر بكرا. وبعدها خبرني كيف بدي أتصرف."],
  ["en", "Is Dr. Mansour available Friday?"],
  ["en", "What time do you close?"],
  ["en", "Are there Dentistry sessions tomorrow, 2026-11-30?"],
  ["en", "Hello"],
  ["en", "Tell me about the entertainment schedule"],
  ["ar", "ممكن تعطيني معلومات عن السفر؟"],
  ["en", "I am trying to sort out clinic sessions. Can you change my mind?"],
].entries())
  test("uncertain or unsupported free-text handoff " + (i + 1), async (t) => {
    const { answer, calls } = fixture();
    const result = await answer({ language, messages: [message] });
    t.diagnostic(JSON.stringify({ language, message, result, calls }));
    assert.equal(result.kind, "reception");
    assert.equal(result.text, receptionHandoff[language]);
    assert.equal(result.emergencyLine, emergencyLine[language]);
    assert.deepEqual(result.cards ?? [], []);
    assert.deepEqual(calls, []);
  });

test("lookup failure uses the same approved bilingual handoff and footer with zero cards", async () => {
  const answer = createPublicAssistant({
    today: () => today,
    readHours: async () => {
      throw Error("fixture unavailable");
    },
    readSessions: async () => {
      throw Error("fixture unavailable");
    },
  });
  for (const [language, message] of [
    ["en", "Is Dr. Lina Mansour available Friday?"],
    ["ar", "شو ساعات المختبر اليوم؟"],
  ]) {
    const result = await answer({ language, messages: [message] });
    assert.equal(result.text, receptionHandoff[language]);
    assert.equal(result.emergencyLine, emergencyLine[language]);
    assert.deepEqual(result.cards ?? [], []);
    assert.equal(result.searchContext, null);
  }
});

test("the API keeps the four guided replies exact and rejects typed text", async () => {
  const { answer, calls } = fixture();
  const handler = assistantHandler(answer);
  const post = async (body) => {
    const result = {
      setHeader() {},
      end(raw) {
        this.body = JSON.parse(raw);
      },
    };
    await handler(
      { method: "POST", headers: { "content-type": "application/json" }, body },
      result,
    );
    return { status: result.statusCode, ...result.body };
  };
  for (const language of ["en", "ar"]) {
    for (const [topic, key] of [
      ["urgent", "emergency"],
      ["private", "private"],
      ["cancel", "cancel"],
      ["clinical", "clinical"],
    ]) {
      const result = await post({
        language,
        message: { topic },
        context: null,
      });
      assert.equal(result.status, 200);
      assert.equal(result.text, rulesCopy[language][key]);
      assert.deepEqual(result.cards ?? [], []);
      assert.ok(!Object.hasOwn(result, "emergencyLine"));
    }
  }
  const result = await post({
    language: "en",
    message: "I cannot breathe.",
    context: null,
  });
  assert.equal(result.status, 400);
  assert.deepEqual(calls, []);
});

test("a near-match clinician name hands off instead of showing another clinician", async () => {
  const { answer, calls } = fixture();
  const result = await answer({
    language: "en",
    messages: ["Is Dr. Lena Mansour available Friday?"],
  });
  assert.equal(result.text, receptionHandoff.en);
  assert.equal(result.emergencyLine, emergencyLine.en);
  assert.deepEqual(result.cards ?? [], []);
  assert.deepEqual(calls, [["sessions", friday]]);
});
