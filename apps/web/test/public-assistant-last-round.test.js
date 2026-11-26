import test from "node:test";
import assert from "node:assert/strict";
import {
  browserPublicRequest as request,
  localRoute,
} from "../server/public-assistant-context.js";

const today = "2026-11-25";
const category = (text) => localRoute(text)?.category;

for (const text of [
  "ابني عم يختنق",
  "البنت عم تختنق",
  "ابوي بلع سم",
  "اختي عم تنزف كتير",
  "جارنا عنده نوبه قلبيه",
  "My daughter swallowed bleach",
  "My husband is having a heart attack",
  "He is having a stroke",
  "She is bleeding a lot",
  "My baby is choking",
])
  test("urgent: " + text, () => assert.equal(category(text), "emergency"));
for (const text of [
  "شو لازم اخد للحرارة؟",
  "شو باخد للسعال؟",
  "What should I take for a fever?",
  "What can I use for a rash?",
])
  test("medical: " + text, () => assert.equal(category(text), "clinical"));
for (const text of [
  "I left a sample yesterday, what did it show?",
  "We did a swab on Monday, is it ready?",
  "I gave blood last week, did anything come back?",
  "عطيت عينه مبارح، شو طلع؟",
  "عملت تحليل الاسبوع الماضي، صار جاهز؟",
])
  test("personal: " + text, () => assert.ok(localRoute(text)?.intent));
for (const text of [
  "What should I take to the lab?",
  "Is a urine test available on Monday?",
  "How should I prepare for a urine culture?",
  "شو لازم جيب معي على المختبر؟",
])
  test("still public: " + text, () => assert.equal(localRoute(text), null));

for (const [text, specialty, date] of [
  [
    "Is there a pediatrician on Monday?",
    "Pediatrics, Neonatology, and General Health",
    "2026-11-30",
  ],
  ["Any dermatologist this Friday?", "Dermatology", "2026-11-27"],
  ["I want to see a urologist on Tuesday", "Urology", "2026-12-01"],
  [
    "Do you have an eye doctor on Thursday?",
    "Ophthalmology & Eye Surgery",
    "2026-11-26",
  ],
  ["Show general surgery on Monday", "General Surgery", "2026-11-30"],
  ["في دكتور جلدية يوم الجمعة؟", "Dermatology", "2026-11-27"],
  ["بدي دكتور قلب نهار الجمعة", "Cardiology", "2026-11-27"],
])
  test("specialty: " + text, () =>
    assert.deepEqual(request(text, null, today), {
      intent: "schedule",
      date,
      specialty,
      clinicianId: null,
    }),
  );
test("a named clinician on a day", () =>
  assert.deepEqual(
    request("Is Dr. Ghazi Sarghani in on Friday?", null, today, [
      {
        professionalId: "doctor:ghazi-sarghani",
        professionalName: "Dr. Ghazi Sarghani",
      },
    ]),
    {
      intent: "schedule",
      date: "2026-11-27",
      specialty: null,
      clinicianId: "doctor:ghazi-sarghani",
    },
  ));
test("fasting question and Arabic hearing follow-up", () => {
  assert.equal(
    request("Is fasting required for a glucose test?", null, today)?.menu
      ?.topic,
    "preparation",
  );
  const prior = {
    lastIntent: "hours",
    service: "laboratory",
    date: "2026-12-01",
    specialty: null,
    clinicianId: null,
  };
  assert.deepEqual(request("وفحص السمع بنفس اليوم؟", prior, today), {
    intent: "hours",
    service: "audiometry",
    date: "2026-12-01",
  });
});
