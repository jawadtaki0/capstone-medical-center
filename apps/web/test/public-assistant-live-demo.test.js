import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicAssistant } from "../server/public-assistant.js";
import {
  emergencyLine,
  receptionHandoff,
} from "../src/public-assistant-safety.js";

// Thursday.
const today = "2026-11-26";
const people = [
  ["Dr. Test Rahal", "doctor:rahal", "Dentistry", "2026-11-30"],
  ["Dr. Test Saad", "doctor:saad", "Dentistry", "2026-11-27"],
];

function ask(message, { language = "en", menu } = {}) {
  const answer = createPublicAssistant({
    demo: true,
    today: () => today,
    matchIntent: async () => ({ band: "low", intents: [] }),
    readHours: async (date) => ({
      date,
      publicationStatus: "published",
      centerClosed: date === "2026-11-29",
      centerHours: { startTime: "08:00", endTime: "17:00" },
      otherServices: [
        { id: "laboratory", startTime: "07:45", endTime: "14:30" },
        { id: "audiometry", startTime: "09:00", endTime: "14:00" },
      ],
    }),
    readSessions: async (date) =>
      people
        .filter(([, , , day]) => day === date)
        .map(([professionalName, professionalId, specialty]) => ({
          date,
          professionalName,
          professionalId,
          specialty,
          sourceSessionId: professionalId + date,
          startTime: "09:00",
          endTime: "17:00",
        })),
  });
  return answer(menu ? { language, menu } : { language, messages: [message] });
}

test("a reply uses the language of the question", async () => {
  const arabic = await ask("الساعة كم بتسكر العيادة بكرا؟");
  assert.equal(arabic.language, "ar");
  assert.equal(arabic.emergencyLine, emergencyLine.ar);
  assert.match(arabic.text, /العيادة/u);
  assert.match(arabic.text, /دوام المركز|المركز 2026-11-27/u);
  assert.match(arabic.text, /17:00/u);
  const english = await ask("When does the lab close tomorrow?", {
    language: "ar",
  });
  assert.equal(english.language, "en");
  assert.match(english.text, /Laboratory 2026-11-27/u);
});

test("a Clinic hours question says Clinic and never invents Clinic hours", async () => {
  const result = await ask("What time does the clinic close tomorrow?");
  assert.match(result.text, /Clinic doctors attend/u);
  assert.match(result.text, /Center 2026-11-27: 08:00–17:00/u);
});

for (const message of [
  "I want to book with Dr Test Rahal",
  "Can I get an appointment with Dr. Test Rahal?",
  "بدي احجز عند الدكتور Test Rahal",
])
  test("a named clinician shows their sessions: " + message, async () => {
    const result = await ask(message);
    assert.equal(result.kind, "sessions");
    assert.deepEqual(
      result.cards.map((card) => card.professional),
      ["Dr. Test Rahal"],
    );
    assert.match(
      result.cards[0].href,
      /^\/request\?professional=doctor%3Arahal/u,
    );
  });

test("an unknown clinician is not replaced by another", async () => {
  const result = await ask("When is Dr Xyzabc available?");
  assert.deepEqual(result.cards ?? [], []);
  assert.doesNotMatch(result.text, /Rahal|Saad/u);
});

for (const [message, extra] of [
  ["How do I register at the lab?", /Online Lab booking is not available/u],
  ["How can I register?", /Reception/u],
  ["كيف بسجل؟", /الاستقبال/u],
])
  test(
    "registration questions get the Register answer: " + message,
    async () => {
      const result = await ask(message);
      const button = await ask(null, {
        language: result.language,
        menu: { topic: "register" },
      });
      assert.ok(result.text.startsWith(button.text));
      assert.match(result.text, extra);
      assert.equal(result.page, "/schedule");
    },
  );

test("registering on a past date says so and offers published days", async () => {
  const result = await ask("I want to register on 17-11-2003");
  assert.equal(result.kind, "dateOptions");
  assert.match(result.text, /unavailable/u);
  assert.deepEqual(result.dateOptions, ["2026-11-27", "2026-11-30"]);
  const picked = await ask(null, {
    menu: { ...result.menu, date: "2026-11-30" },
  });
  assert.equal(picked.cards[0].professional, "Dr. Test Rahal");
});

for (const message of [
  "wat tym lab opn tmrw",
  "wen does lab clos tmrw",
  "lab opn hrs tmrw pls",
])
  test("chat shorthand reaches tomorrow's Lab hours: " + message, async () => {
    const result = await ask(message);
    assert.match(result.text, /Laboratory 2026-11-27: 07:45–14:30/u);
  });

for (const message of [
  "what do you know about the russian/ukranian war?",
  "who won the election?",
  "can you recommend a phone?",
  "شو رأيك بالحرب؟",
])
  test(
    "unrelated questions get the fixed off-topic reply: " + message,
    async () => {
      const result = await ask(message);
      assert.equal(result.kind, "demoOffTopic");
      assert.deepEqual(result.cards ?? [], []);
    },
  );

for (const message of [
  "Something awful happened and I need help",
  "My father fell down and is not answering",
  "I feel very strange today",
  "My knee hurts, which doctor?",
  "Do you accept my insurance?",
  "Where can I park near the building?",
])
  test(
    "a possible need for a person is never called off-topic: " + message,
    async () => {
      const result = await ask(message);
      assert.notEqual(result.kind, "demoOffTopic");
    },
  );

for (const message of [
  "how do i sign in to a new account?",
  "How can I create an account?",
  "كيف بعمل حساب جديد؟",
])
  test("account questions point to My account: " + message, async () => {
    const result = await ask(message);
    assert.equal(result.page, "/account");
    assert.match(result.text, /Create account|إنشاء حساب/u);
  });

for (const [message, kind] of [
  ["hello", "greeting"],
  ["thanks", "thanks"],
  ["مرحبا", "greeting"],
  ["شكرا", "thanks"],
])
  test("greetings and thanks offer the topic buttons: " + message, async () => {
    const result = await ask(message);
    assert.equal(result.kind, kind);
    assert.notEqual(result.text, receptionHandoff[result.language]);
    assert.deepEqual(
      result.menuOptions.map(({ topic }) => topic),
      ["hours", "doctor", "prices", "preparation", "register", "about"],
    );
    assert.equal(result.emergencyLine, emergencyLine[result.language]);
  });

for (const language of ["en", "ar"])
  test("the Prices button asks which test first " + language, async () => {
    const list = await ask(null, { language, menu: { topic: "prices" } });
    assert.equal(list.kind, "menu");
    const choices = list.menuOptions.map(({ choice }) => choice);
    for (const choice of ["clinic", "audiometry", "hba1c"])
      assert.ok(choices.includes(choice));
    const test_ = await ask(null, {
      language,
      menu: { topic: "prices", choice: "hba1c" },
    });
    assert.match(test_.text, /HbA1c/u);
    assert.match(test_.text, /not published|غير منشور/u);
    const invalid = await ask(null, {
      language,
      menu: { topic: "prices", choice: "nothing" },
    });
    assert.equal(invalid.text, receptionHandoff[language]);
  });

for (const message of [
  "i cant breathe",
  "cancel my appointment",
  "is my test ready?",
])
  test("protected replies are unchanged: " + message, async () => {
    const result = await ask(message);
    assert.ok(["emergency", "private"].includes(result.kind));
    assert.deepEqual(result.cards ?? [], []);
    assert.equal(result.menuOptions, undefined);
  });
