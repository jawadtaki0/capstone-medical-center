import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicAssistant } from "../server/public-assistant.js";
import { rulesCopy } from "../server/public-assistant-gate.js";
import {
  emergencyLine,
  receptionHandoff,
} from "../src/public-assistant-safety.js";
import {
  preselectionDate,
  requestSelectionUrl,
  validatedPreselection,
} from "../src/request-selection.js";

const today = "2026-11-25",
  thursday = "2026-11-26",
  friday = "2026-11-27",
  sunday = "2026-11-29";
const rows = [
  [thursday, "Amal Mansour", "Cardiology", "amal-m", "09:00", "11:30"],
  [friday, "Kamal Mansour", "Dentistry", "kamal-m", "11:45", "13:00"],
  [friday, "Amal Nassar", "Dermatology", "amal-n", "09:15", "11:30"],
].map(
  ([
    date,
    professionalName,
    specialty,
    professionalId,
    startTime,
    endTime,
  ]) => ({
    date,
    professionalName,
    specialty,
    professionalId,
    startTime,
    endTime,
    sourceSessionId: professionalId + "-fixture",
    published: true,
    available: true,
  }),
);
function fixture() {
  const lookups = [],
    attempts = [];
  const answer = createPublicAssistant({
    demo: true,
    today: () => today,
    async matchIntent(message) {
      attempts.push(message);
      return { band: "low", intents: [] };
    },
    async readSessions(date) {
      lookups.push(["clinic", date]);
      return rows.filter((r) => r.date === date);
    },
    async readHours(date) {
      lookups.push(["hours", date]);
      return {
        date,
        publicationStatus: "published",
        centerClosed: date === sunday,
        centerHours: { startTime: "08:00", endTime: "17:00" },
        otherServices: [
          { id: "laboratory", startTime: "08:00", endTime: "14:30" },
          { id: "audiometry", startTime: "09:00", endTime: "15:00" },
        ],
      };
    },
  });
  const ask = (message, lang = "en", extra = {}) =>
    answer({ language: lang, messages: [message], ...extra });
  return { ask, lookups, attempts };
}
const questions = [
  ["en", "Could I see Dr Amal Mansour’s posted appointment slots?", 0],
  ["ar", "بدي شوف مواعيد الدكتورة أمل منصور المنشورة", 0],
  ["en", "Which published windows are there for cardiology?", 0],
  ["ar", "عندكن مواعيد بنهار الخميس مع اختصاص القلب؟", 0],
  ["en", "Does Dr. Kamal Mansour have a session this Friday?", 1],
  ["ar", "إمتى فيني شوف الدكتور كمال منصور بطب الأسنان؟", 1],
  ["en", "Find a published dental visit Friday.", 1],
  ["ar", "عندكن جلسة بالجلدية نهار الجمعة؟", 2],
  ["ar", "شو الوقت المنشور للدكتورة أمل نصار بالجلدية؟", 2],
  ["en", "What is listed for Doctor Mansour?", null, "clarify"],
  ["en", "Is Dr Albert Nader on the published schedule?", null, "reception"],
  ["ar", "في مواعيد جلدية متاحة الخميس؟", null, "empty"],
];
for (const [i, [lang, query, row, kind]] of questions.entries())
  test("availability " + (i + 1), async (t) => {
    const { ask, lookups } = fixture();
    const r = await ask(query, lang);
    t.diagnostic(JSON.stringify({ result: r, lookups }));
    assert.equal(r.kind, kind ?? "sessions");
    if (row !== null)
      assert.deepEqual(
        r.cards.map((c) => c.href),
        [requestSelectionUrl(rows[row])],
      );
    else assert.deepEqual(r.cards ?? [], []);
    assert.equal(r.emergencyLine, emergencyLine[lang]);
    assert.ok(lookups.some(([path]) => path === "clinic"));
  });

const exact = {
  en: {
    identity:
      "I'm Ask Cedar, the assistant for Cedar's Clinic, Lab and Audiometry services.",
    creator:
      "I was developed by Jawad Taki at LAU for Cedar. Contact: +961 81 814 554 or jawadtaki0@gmail.com.",
    offTopic:
      "I can only help with Cedar's services, hours, doctors and bookings.",
  },
  ar: {
    identity:
      "أنا اسأل سيدر، مساعد خدمات العيادة والمختبر وفحوصات السمع في سيدر.",
    creator:
      "طوّرني جواد تقي في الجامعة اللبنانية الأميركية لصالح سيدر. للتواصل: ‎+961 81 814 554 أو jawadtaki0@gmail.com.",
    offTopic:
      "يمكنني مساعدتك فقط في خدمات سيدر وساعات العمل والأطباء والحجوزات.",
  },
};
for (const [kind, examples] of [
  [
    "identity",
    [
      ["en", "Could you introduce yourself briefly?"],
      ["en", "What's your name, and what can you do?"],
      ["en", "Which Cedar helper is this?"],
      ["en", "What should I call this chat assistant?"],
      ["ar", "ممكن تعرّف عن نفسك شوي؟"],
      ["ar", "شو منسمّيك هون؟"],
      ["ar", "حضرتك مين وشو دورك هون؟"],
    ],
  ],
  [
    "creator",
    [
      ["en", "Who programmed this chatbot?"],
      ["en", "May I ask who developed this tool?"],
      ["en", "Who designed the assistant for Cedar?"],
      ["en", "Who is behind this chatbot and where can I reach them?"],
      ["ar", "خبرني مين صمّم المساعد الرقمي"],
      ["ar", "مين المبرمج اللي اشتغل ع هالمساعد؟"],
      ["ar", "كيف بتواصل مع اللي برمج هالمساعد؟"],
    ],
  ],
  [
    "offTopic",
    [
      ["en", "Suggest a sandwich recipe and a dessert."],
      ["en", "What is the capital of Portugal?"],
      ["en", "I need an idea for a wedding playlist. Can you help with that?"],
      ["ar", "اقترح فيلم وبعدين عطيني وصفة"],
      ["ar", "قديش حق تذكرة الطيارة لروما؟"],
      ["ar", "اعطيني افكار لتزيين الصالون بالبيت"],
    ],
  ],
])
  for (const [i, [lang, query]] of examples.entries())
    test("fixed " + kind + " " + (i + 1), async () => {
      const { ask, attempts, lookups } = fixture();
      const r = await ask(query, lang);
      assert.equal(r.text, exact[lang][kind]);
      assert.equal(r.emergencyLine, emergencyLine[lang]);
      assert.equal(r.parts, undefined);
      assert.deepEqual(attempts, []);
      assert.deepEqual(lookups, []);
      if (kind === "offTopic") assert.equal(r.topicOptions.length, 4);
    });

for (const [i, [lang, query, pick, isClinic]] of [
  ["en", "Clinic building hours on 2026-11-18?", thursday, false],
  ["ar", "شو ساعات المختبر بـ ٢٩ تشرين الثاني؟", thursday, false],
  ["en", "Audiometry opening hours on 2027-01-99?", thursday, false],
  ["ar", "وقت فتح المركز بيوم ٧ كانون الثاني ٢٠٣٠؟", thursday, false],
  ["en", "Find Cardiology visits on November 6, 2026.", thursday, true],
  ["ar", "في جلسات للدكتور كمال منصور الأحد؟", friday, true],
  ["en", "Is Dr. Amal Nassar available on November 31, 2026?", friday, true],
  ["ar", "شو مواعيد طب الأسنان بتاريخ 03/04/2038؟", friday, true],
].entries())
  test("picker " + (i + 1), async () => {
    const { ask, lookups } = fixture();
    const r = await ask(query, lang);
    assert.equal(r.kind, "dateOptions");
    assert.ok(r.dateOptions?.includes(pick));
    assert.ok(!r.dateOptions.includes(sunday));
    if (isClinic) assert.deepEqual(r.dateOptions, [pick]);
    const before = lookups.length;
    const selected = await ask(query, lang, {
      selectedDate: pick,
      searchContext: r.searchContext,
    });
    assert.equal(selected.kind, isClinic ? "sessions" : "library");
    assert.ok(lookups.slice(before).some(([, date]) => date === pick));
    if (isClinic) assert.ok(selected.cards.every((c) => c.date === pick));
    else assert.ok(selected.text.includes(pick));
    const forged = await ask(query, lang, {
      selectedDate: sunday,
      searchContext: r.searchContext,
    });
    assert.equal(forged.text, receptionHandoff[lang]);
    assert.deepEqual(forged.cards ?? [], []);
  });

for (const [i, [lang, query, expected]] of [
  ["en", "Look for dental windows on 18/10/2006.", "dateOptions"],
  ["ar", "بدي مواعيد اسنان في 19-09-2008", "dateOptions"],
  ["en", "Look up my dental appointment for 18/10/2006.", "private"],
  ["ar", "اعرض نتيجة المختبر الخاصة فيني بتاريخ 19-09-2008", "private"],
].entries())
  test("privacy " + (i + 1), async () => {
    const { ask } = fixture();
    assert.equal((await ask(query, lang)).kind, expected);
  });

for (const [i, [lang, key, query]] of [
  ["en", "private", "The clinic sent me a note. Please retrieve my report."],
  ["ar", "private", "وصلني إشعار اليوم. ابعتولي نتيجة فحصي الخاصة هون."],
  ["en", "cancel", "I won't be able to come. Please cancel my booking."],
  ["ar", "cancel", "صار عندي شغل نهار الجمعة. فيك تلغي حجزي؟"],
  [
    "en",
    "clinical",
    "The tablets make me uncomfortable. Should I reduce my medication dose?",
  ],
  ["ar", "symptom", "عم بحس بألم بركبتي من كم يوم. أي اختصاصي بتنصحني راجع؟"],
].entries())
  test("single protected " + (i + 1), async () => {
    const { ask, attempts, lookups } = fixture();
    const r = await ask(query, lang);
    assert.equal(
      r.text,
      key === "symptom" ? receptionHandoff[lang] : rulesCopy[lang][key],
    );
    assert.equal(r.parts, undefined);
    assert.deepEqual(r.cards ?? [], []);
    assert.deepEqual(attempts, []);
    assert.deepEqual(lookups, []);
  });

const url = requestSelectionUrl(rows[0]).split("?")[1];
const arabicUrl = url + "&lang=ar";
for (const [i, [search, expected]] of [
  [arabicUrl, rows[0]],
  [arabicUrl.replace("09%3A00", "09%3A10"), null],
  [arabicUrl + "&lang=en", null],
  [arabicUrl.replace("amal-m-fixture", "wrong"), null],
].entries())
  test("Arabic prefill " + (i + 1), () => {
    assert.deepEqual(validatedPreselection(search, rows), expected);
    assert.equal(preselectionDate(search), i === 2 ? null : thursday);
  });
