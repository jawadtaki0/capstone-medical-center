import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistant } from "../server/public-assistant.js";

const today = "2026-11-25";
const saturday = "2026-11-28";

test("a new undated service question uses Beirut today; an explicit visit reference keeps the displayed date", async () => {
  const reads = [];
  const answer = createAssistant({
    today: () => today,
    readSessions: async (date) => [
      {
        date,
        professionalName: "Dr. Layla Mansour",
        professionalId: "layla",
        sourceSessionId: "s1",
        specialty: "Dentistry",
        startTime: "10:00",
        endTime: "12:00",
      },
    ],
    readHours: async (date) => {
      reads.push(date);
      return {
        date,
        publicationStatus: "published",
        otherServices: [
          {
            id: "laboratory",
            startTime: "08:00",
            endTime: date === saturday ? "12:00" : "14:30",
          },
        ],
      };
    },
  });
  const clinic = "Show Dentistry sessions on Saturday.";
  const first = await answer({ language: "en", messages: [clinic] });
  assert.equal(first.cards[0].date, saturday);
  const regular = await answer({
    language: "en",
    messages: [clinic, "Can I have the Laboratory opening hours?"],
    searchContext: first.searchContext,
  });
  const visit = await answer({
    language: "ar",
    messages: [clinic, "خلال نفس الزيارة، أي ساعة بيسكر المختبر؟"],
    searchContext: first.searchContext,
  });
  assert.deepEqual(reads, [today, saturday]);
  assert.equal(regular.kind, "library");
  assert.match(regular.text, /2026-11-25.*08:00–14:30/u);
  assert.equal(visit.kind, "library");
  assert.match(visit.text, /2026-11-28.*12:00/u);
  assert.deepEqual(regular.cards ?? [], []);
  assert.deepEqual(visit.cards ?? [], []);
  for (const result of [regular, visit]) {
    const [payload] = result.searchContext.split(".");
    assert.equal(
      JSON.parse(Buffer.from(payload, "base64url")).filters,
      undefined,
    );
  }
});

test("Arabizi payment intent for a named lab test uses the fee reply in Arabic", async () => {
  const observed = [];
  const answer = createAssistant({ observe: (event) => observed.push(event) });
  const result = await answer({
    language: "ar",
    messages: ["Shou bnadfa3 3al TSH?"],
  });
  assert.equal(result.kind, "reception");
  assert.equal(
    result.text,
    "سعر الفحص غير منشور. تواصل مع الاستقبال للاستفسار عن التكلفة.",
  );
  assert.deepEqual(result.cards ?? [], []);
  assert.deepEqual(observed, []);
});

test("mixed-language booking and preparation questions use the requested reply language", async () => {
  const answer = createAssistant({});
  for (const [message, pattern] of [
    ["Can I book a laboratory visit online?", /غير متاح.*الاستقبال/u],
    ["How do I prepare for a hearing test?", /لا تحتاج.*تحضير/u],
  ]) {
    const result = await answer({ language: "ar", messages: [message] });
    assert.equal(result.kind, "library");
    assert.match(result.text, pattern);
    assert.doesNotMatch(result.text, /\p{Script=Latin}/u);
    assert.deepEqual(result.cards ?? [], []);
  }
});
