import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicAssistant } from "../server/public-assistant.js";
import {
  emergencyLine,
  receptionHandoff,
} from "../src/public-assistant-safety.js";

const today = "2026-11-25";
const friday = "2026-11-27";

function assistant({ fail = false } = {}) {
  return createPublicAssistant({
    demo: true,
    today: () => today,
    matchIntent: async () => {
      throw Error("Buttons must not use the matcher");
    },
    readHours: async (date) => {
      if (fail) throw Error("offline");
      return {
        date,
        publicationStatus: "published",
        centerClosed: date === "2026-11-29",
        centerHours: { startTime: "08:00", endTime: "17:00" },
        otherServices: [
          { id: "laboratory", startTime: "08:00", endTime: "14:30" },
          { id: "audiometry", startTime: "09:00", endTime: "14:00" },
        ],
      };
    },
    readSessions: async (date) => {
      if (fail) throw Error("offline");
      return date === friday
        ? [
            {
              date,
              professionalName: "Dr. Test Teeth",
              professionalId: "doctor:teeth",
              sourceSessionId: "3:teeth",
              specialty: "Dentistry",
              startTime: "10:00",
              endTime: "12:00",
            },
          ]
        : [];
    },
  });
}
const tap = (menu, language = "en", options) =>
  assistant(options)({ language, menu });

for (const language of ["en", "ar"]) {
  test(
    "hours: service, then date, then published hours " + language,
    async () => {
      const start = await tap({ topic: "hours" }, language);
      assert.deepEqual(
        start.menuOptions.map(({ choice }) => choice),
        ["center", "lab", "audio"],
      );
      const dates = await tap({ topic: "hours", choice: "lab" }, language);
      assert.ok(dates.dateOptions.includes(friday));
      assert.ok(!dates.dateOptions.includes("2026-11-29"));
      const result = await tap(
        { topic: "hours", choice: "lab", date: friday },
        language,
      );
      assert.match(result.text, /2026-11-27.*08:00–14:30/u);
      for (const reply of [start, dates, result])
        assert.equal(reply.emergencyLine, emergencyLine[language]);
    },
  );

  test(
    "doctor: specialty, date, then a preselected request card " + language,
    async () => {
      const start = await tap({ topic: "doctor" }, language);
      assert.deepEqual(
        start.menuOptions.map(({ choice }) => choice),
        ["Dentistry"],
      );
      const dates = await tap(
        { topic: "doctor", choice: "Dentistry" },
        language,
      );
      assert.deepEqual(dates.dateOptions, [friday]);
      const result = await tap(
        { topic: "doctor", choice: "Dentistry", date: friday },
        language,
      );
      assert.equal(result.cards.length, 1);
      assert.match(
        result.cards[0].href,
        /^\/request\?professional=doctor%3Ateeth&date=2026-11-27&session=3%3Ateeth&start=10%3A00&end=12%3A00$/u,
      );
      assert.equal(result.emergencyLine, emergencyLine[language]);
    },
  );

  test("prices, preparation, register and about " + language, async () => {
    const price = await tap({ topic: "prices" }, language);
    assert.match(
      price.text,
      language === "ar" ? /غير منشورة/u : /not published/u,
    );
    const list = await tap({ topic: "preparation" }, language);
    assert.ok(list.menuOptions.some(({ choice }) => choice === "hba1c"));
    assert.ok(list.menuOptions.some(({ choice }) => choice === "audiometry"));
    const prep = await tap({ topic: "preparation", choice: "hba1c" }, language);
    assert.match(prep.text, /HbA1c/u);
    const hearing = await tap(
      { topic: "preparation", choice: "audiometry" },
      language,
    );
    assert.equal(hearing.page, "/services/audiometry");
    const register = await tap({ topic: "register" }, language);
    assert.equal(register.page, "/schedule");
    const about = await tap({ topic: "about" }, language);
    assert.match(about.text, language === "ar" ? /سيدر/u : /Ask Cedar/u);
    for (const reply of [price, list, prep, hearing, register, about]) {
      assert.equal(reply.emergencyLine, emergencyLine[language]);
      assert.deepEqual(reply.cards ?? [], []);
    }
  });
}

for (const menu of [
  { topic: "unknown" },
  { topic: "hours", choice: "pharmacy" },
  { topic: "hours", choice: "lab", date: "2027-01-01" },
  { topic: "hours", choice: "lab", date: "2026-11-29" },
  { topic: "doctor", choice: "<script>" },
  { topic: "preparation", choice: "x".repeat(200) },
  "hours",
  null,
])
  test(
    "an invalid selection goes to Reception: " + JSON.stringify(menu),
    async () => {
      const result = await tap(menu);
      assert.equal(result.text, receptionHandoff.en);
      assert.equal(result.emergencyLine, emergencyLine.en);
      assert.deepEqual(result.cards ?? [], []);
    },
  );

test("a schedule that cannot be read goes to Reception", async () => {
  for (const menu of [
    { topic: "doctor" },
    { topic: "hours", choice: "lab" },
    { topic: "hours", choice: "lab", date: friday },
  ]) {
    const result = await tap(menu, "en", { fail: true });
    assert.equal(result.text, receptionHandoff.en);
  }
});
