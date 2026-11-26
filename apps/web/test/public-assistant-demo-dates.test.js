import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicAssistant } from "../server/public-assistant.js";
import { resolveDay } from "../server/public-assistant-dates.js";
import { protectedGate } from "../server/public-assistant-gate.js";

// Wednesday.
const today = "2026-11-25";

for (const [message, day] of [
  ["28/11", "2026-11-28"],
  ["1-12-2026", "2026-12-01"],
  ["on the 28th", "2026-11-28"],
  ["the 1st", "2026-12-01"],
  ["يوم ٢٨", "2026-11-28"],
  ["نهار 30", "2026-11-30"],
  ["28 الشهر", "2026-11-28"],
  ["28 نوفمبر", "2026-11-28"],
  ["1 ديسمبر", "2026-12-01"],
  ["أول كانون الأول", "2026-12-01"],
  ["الأول من كانون الأول", "2026-12-01"],
  ["in two days", "2026-11-27"],
  ["بعد يومين", "2026-11-27"],
  ["this afternoon", "2026-11-25"],
])
  test("reads the date: " + message, () =>
    assert.equal(resolveDay(message, today).day, day),
  );

for (const message of ["31/11", "Friday in January", "35th of November"])
  test("never guesses a day: " + message, () => {
    const result = resolveDay(message, today);
    assert.equal(result.day, null);
    assert.equal(result.specified, true);
  });

function assistant() {
  return createPublicAssistant({
    demo: true,
    today: () => today,
    matchIntent: async () => ({ band: "low", intents: [] }),
    readHours: async (date) => ({
      date,
      publicationStatus: "published",
      centerHours: { startTime: "08:00", endTime: "17:00" },
      otherServices: [
        { id: "laboratory", startTime: "08:00", endTime: "14:30" },
        { id: "audiometry", startTime: "09:00", endTime: "14:30" },
      ],
    }),
    readSessions: async () => [],
  });
}
const ask = (message) =>
  assistant()({
    language: /[؀-ۿ]/u.test(message) ? "ar" : "en",
    messages: [message],
  });

for (const [message, day] of [
  ["I'm coming on Friday. When does the center close?", "2026-11-27"],
  ["Planning for Monday! What are the audiometry hours?", "2026-11-30"],
  ["الجمعة؟ أي ساعة بيسكر المركز", "2026-11-27"],
  ["What are the center hours on 28/11?", "2026-11-28"],
  ["What are the lab hours on the 30th?", "2026-11-30"],
  ["شو دوام المركز يوم ٢٨؟", "2026-11-28"],
])
  test("answers for the requested day only: " + message, async () => {
    const result = await ask(message);
    assert.equal(result.kind, "library");
    assert.match(result.text, new RegExp(day));
    assert.ok(!result.text.includes(today));
  });

test("an unreadable date is not called unavailable", async () => {
  const result = await ask("What are the lab hours the week after next?");
  assert.equal(result.kind, "dateOptions");
  assert.doesNotMatch(result.text, /unavailable/iu);
  assert.ok(result.dateOptions.length);
});

for (const message of [
  "Is my blood test ready?",
  "I did a test yesterday, is it ready?",
  "Are the results of my test out?",
  "Can you look up the results for me?",
  "Is there a report under my name?",
  "فحوصاتي جهزت؟",
  "وصلت نتائج فحصي؟",
  "بدي شوف تحاليلي",
])
  test("a personal result request is private: " + message, () =>
    assert.equal(protectedGate(message), "private"),
  );

for (const message of [
  "How do I get ready for my blood test?",
  "What should I do to be ready for my test?",
  "How long do lab results take?",
  "Is the lab ready to take visitors?",
  "Is there a published report time for cultures?",
  "كيف بحضر حالي لفحص الدم؟",
])
  test("public education stays public: " + message, () =>
    assert.notEqual(protectedGate(message), "private"),
  );
