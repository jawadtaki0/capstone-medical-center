import test from "node:test";
import assert from "node:assert/strict";
import {
  browserPublicRequest as request,
  localRoute,
} from "../server/public-assistant-context.js";
import { fixedDemoIntent } from "../server/public-assistant-demo.js";

const today = "2026-11-25";

for (const text of [
  "My father just passed out and is not breathing",
  "The old man next to me stopped breathing",
  "Our neighbour is unconscious on the floor",
  "She isn't breathing, help",
  "جدي مش عم يتنفس",
  "امي غابت عن الوعي هلق",
])
  test("urgent: " + text, () =>
    assert.equal(localRoute(text)?.category, "emergency"),
  );
for (const text of [
  "Is the lab open if my father comes on Saturday?",
  "What time does the Center close on Friday?",
])
  test("not urgent: " + text, () => assert.equal(localRoute(text), null));

for (const text of [
  "شو يعني اذا السكر عندي 180؟",
  "لازم وقف المميع قبل فحص الدم؟",
  "Is a blood pressure of 150 over 95 dangerous for me?",
  "Should I skip my insulin before the test?",
])
  test("medical: " + text, () =>
    assert.equal(localRoute(text)?.category, "clinical"),
  );

for (const text of [
  "Did the clinic say yes to the time I asked for?",
  "صار جاهز الشي اللي سحبوه مني الأسبوع الماضي؟",
  "وين صار طلب ابني اللي قدمته؟",
  "My name is Test Person, born 1990, what did my hearing test show?",
])
  test("personal stays local: " + text, () =>
    assert.ok(localRoute(text)?.intent),
  );
for (const text of [
  "How do I prepare for my hearing test?",
  "Can I reserve a lab visit on the website?",
])
  test("public stays public: " + text, () =>
    assert.equal(localRoute(text), null),
  );

const hours = (service, date) => ({ intent: "hours", service, date });
test("closing wording and day or service follow-ups", () => {
  assert.deepEqual(
    request("What time does the Center shut on Saturday?", null, today),
    hours("center", "2026-11-28"),
  );
  const prior = {
    lastIntent: "hours",
    service: "center",
    date: "2026-11-28",
    specialty: null,
    clinicianId: null,
  };
  assert.deepEqual(
    request("What about the Thursday after today?", prior, today),
    { intent: "hours", date: "2026-11-26", service: "center" },
  );
  for (const text of [
    "same day for hearing tests please",
    "وفحوصات السمع بنفس النهار؟",
  ])
    assert.deepEqual(request(text, prior, today), {
      intent: "hours",
      date: "2026-11-28",
      service: "audiometry",
    });
});
for (const text of [
  "Which dentist is in on Saturday?",
  "مين دكتور الأسنان يوم السبت؟",
])
  test("specialty question: " + text, () =>
    assert.deepEqual(request(text, null, today), {
      intent: "schedule",
      date: "2026-11-28",
      specialty: "Dentistry",
      clinicianId: null,
    }),
  );
test("Arabic hearing booking and a person question", () => {
  assert.deepEqual(request("فيني احجز فحص سمع من الموقع؟", null, today), {
    intent: "bookingPolicy",
    service: "audiometry",
  });
  for (const text of ["Are you a real person?", "انت انسان؟"])
    assert.equal(fixedDemoIntent(text, null), "identity");
});
