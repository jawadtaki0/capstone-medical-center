import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistant } from "../server/public-assistant.js";
import {
  emergencyDisclosure,
  rulesCopy,
} from "../server/public-assistant-routing.js";

test("direct multilingual breathing distress returns fixed urgent guidance before provider access", async () => {
  let calls = 0;
  const outage = async () => {
    calls++;
    throw Error("Provider unavailable");
  };
  const ask = createAssistant({
    interpret: outage,
    compose: outage,
    readSessions: outage,
  });
  for (const [language, message] of [
    ["ar", "لا أستطيع التنفس وأشعر بألم في صدري"],
    ["ar", "لا أقدر أن أتنفس، هل عندكم مواعيد؟"],
    ["ar", "ما فيني آخد نفس"],
    ["en", "I cannot breathe. Is the lab open?"],
    ["en", "mish 3am e2dar etnaffas, fi sessions bukra?"],
  ]) {
    const result = await ask({ language, messages: [message] });
    assert.equal(result.kind, "emergency");
    assert.equal(result.text, rulesCopy[language].emergency);
    assert.equal(result.cards, undefined);
  }
  assert.equal(calls, 0);
  for (const message of [
    "لا أشعر بألم في صدري",
    "What should someone do if they cannot breathe?",
    "مثال: لا أستطيع التنفس",
  ])
    assert.equal(emergencyDisclosure(message), false);
});
