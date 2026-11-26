import test from "node:test";
import assert from "node:assert/strict";
import { localRoute } from "../server/public-assistant-context.js";

for (const question of [
  "بدي كنسل موعد ابني",
  "فيني كنسل حجز بنتي؟",
  "ما بقا بدي موعد بنتي، الغوه",
])
  test("everyday Arabic cancellation opens cancellation: " + question, () =>
    assert.equal(localRoute(question).intent, "cancel_request"),
  );
for (const question of [
  "Can I take ibuprofen while waiting for my results?",
  "Should I stop my blood pressure tablets before my appointment?",
  "فيني اخد مسكن قبل ما تطلع نتيجتي؟",
  "هل لازم وقف دوا الضغط قبل موعدي؟",
])
  test("medication advice gets the clinical refusal: " + question, () =>
    assert.deepEqual(localRoute(question), {
      category: "clinical",
      intent: null,
    }),
  );
test("own records and public questions keep their routes", () => {
  assert.deepEqual(localRoute("Show my lab results"), {
    category: "private",
    intent: "my_results",
  });
  assert.equal(localRoute("بدي شوف مواعيدي").intent, "my_bookings");
  assert.equal(localRoute("When does the Lab open on Saturday?"), null);
  assert.equal(localRoute("بدي الغي موعدي").intent, "cancel_request");
});
