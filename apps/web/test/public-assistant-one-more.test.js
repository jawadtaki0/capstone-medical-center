import test from "node:test";
import assert from "node:assert/strict";
import {
  browserPublicRequest as request,
  localRoute,
} from "../server/public-assistant-context.js";

const today = "2026-11-25";
const monday = "2026-11-30";

for (const text of [
  "Is it safe to double my diabetes pills?",
  "My hemoglobin is 8, is that serious?",
  "Can I mix these tablets with my antibiotic?",
])
  test("medical: " + text, () =>
    assert.equal(localRoute(text)?.category, "clinical"),
  );

for (const [word, specialty] of [
  ["stomach doctor", "Gastroenterology"],
  ["digestive specialist", "Gastroenterology"],
  ["speech therapist", "Speech, Language, and Swallowing Therapist"],
  ["kidney doctor", "Urology"],
  ["women's doctor", "Gynecology"],
  ["baby doctor", "Pediatrics, Neonatology, and General Health"],
  ["teeth doctor", "Dentistry"],
  ["surgeon", "General Surgery"],
])
  test("lay specialty: " + word, () =>
    assert.equal(
      request("Is there a " + word + " on Monday?", null, today)?.specialty,
      specialty,
    ),
  );
for (const [word, specialty] of [
  ["اخصائية تغذية", "Dietitian"],
  ["دكتور تغذية", "Dietitian"],
  ["دكتور جلد", "Dermatology"],
  ["دكتورة نسائية", "Gynecology"],
  ["دكتور سنان", "Dentistry"],
  ["دكتور معدة", "Gastroenterology"],
  ["معالج نطق", "Speech, Language, and Swallowing Therapist"],
])
  test("lay specialty: " + word, () =>
    assert.equal(
      request("في " + word + " يوم الاثنين؟", null, today)?.specialty,
      specialty,
    ),
  );

const prior = {
  lastIntent: "hours",
  service: "center",
  date: today,
  specialty: null,
  clinicianId: null,
};
test("tomorrow and hearing follow-ups, open-until and request wording", () => {
  assert.deepEqual(request("وبكرا؟", prior, today), {
    intent: "hours",
    service: "center",
    date: "2026-11-26",
  });
  assert.deepEqual(
    request("وكمان السمع بنفس اليوم", { ...prior, date: monday }, today),
    { intent: "hours", service: "audiometry", date: monday },
  );
  assert.deepEqual(request("المختبر لأي ساعة فاتح يوم السبت؟", null, today), {
    intent: "hours",
    service: "laboratory",
    date: "2026-11-28",
  });
  assert.equal(
    request("How can I request a clinic visit?", null, today)?.menu?.topic,
    "register",
  );
});
