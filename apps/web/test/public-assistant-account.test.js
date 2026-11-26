import test from "node:test";
import assert from "node:assert/strict";
import { createPublicAssistant } from "../server/public-assistant.js";
import { rulesCopy } from "../server/public-assistant-gate.js";

for (const [language, message, accountIntent] of [
  ["en", "Show my released laboratory reports", "my_results"],
  ["ar", "وين بلاقي نتائجي؟", "where_results"],
  ["en", "Where can I find my lab results?", "where_results"],
  ["en", "Show my Clinic bookings", "my_bookings"],
  ["ar", "شو صار بموعدي؟", "booking_status"],
  ["en", "Please cancel my appointment", "cancel_request"],
  ["en", "Show the lab results for my aunt", undefined],
  ["en", "What do my lab results mean?", undefined],
]) {
  test(message, async () => {
    const attempts = [];
    const answer = createPublicAssistant({
      demo: true,
      matchIntent: async (value) => attempts.push(value),
    });
    const result = await answer({ language, messages: [message] });
    assert.equal(result.accountIntent, accountIntent);
    assert.deepEqual(result.cards ?? [], []);
    assert.deepEqual(attempts, []);
    if (message.includes("mean"))
      assert.equal(result.text, rulesCopy.en.clinical);
  });
}
