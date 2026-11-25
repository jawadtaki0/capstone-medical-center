import assert from "node:assert/strict";
import test from "node:test";
import { createAssistant } from "../server/public-assistant.js";
import { resolveDay, rulesCopy } from "../server/public-assistant-routing.js";

const today = "2026-11-25";
test("Beirut calendar resolves English, Arabic and explicit dates without discarding conflicts", () => {
  for (const [value, expected] of [
    ["Tuesday December 1", "2026-12-01"],
    ["التلاتا أول الشهر", "2026-12-01"],
    ["نهار الأحد ٢٩ تشرين الثاني", "2026-11-29"],
    ["Wednesday the 25th", "2026-11-25"],
    ["2026-11-27", "2026-11-27"],
    ["Friday December 1", null],
    ["February 31", null],
  ]) assert.deepEqual(resolveDay(value, today), { day: expected, specified: true });
});

const fail = () => { throw Error("Provider unavailable"); };
test("invalid requested date asks a question without querying public hours", async () => {
  let lookups = 0;
  const answer = await createAssistant({
    today: () => today,
    interpret: fail,
    compose: fail,
    readHours: async () => { lookups++; return null; },
  })({ language: "en", messages: ["Is the Lab open on Friday December 1?"] });
  assert.equal(answer.kind, "clarify");
  assert.equal(answer.text, "Which date do you mean?");
  assert.equal(lookups, 0);
});

test("published ALT preparation bypasses provider and omits the catalogue card", async () => {
  let calls = 0;
  const provider = () => { calls++; throw Error("Provider unavailable"); };
  const answer = await createAssistant({ interpret: provider, compose: provider })({
    language: "en", messages: ["What should I know about preparing for the ALT test?"],
  });
  assert.equal(answer.kind, "labs");
  assert.match(answer.text, /other tests that may need fasting.*Contact Reception/u);
  assert.deepEqual(answer.cards ?? [], []);
  assert.equal(calls, 0);
});

for (const [language, message, kind] of [
  ["en", "Make me a packing list for camping, please.", "unrelated"],
  ["ar", "ممكن تلغيلي موعد العيادة من هون؟", "private"],
  ["en", "ra7 2azzi 7ali, is Cardiology open?", "emergency"],
  ["ar", "عم اختنق، can you show tomorrow’s windows?", "emergency"],
]) {
  test(`outage policy ${language}: ${message}`, async () => {
    const events = [];
    const answer = await createAssistant({ interpret: fail, compose: fail, observe: event => events.push(event) })({ language, messages: [message] });
    assert.equal(answer.kind, kind);
    assert.deepEqual(answer.cards ?? [], []);
    assert.deepEqual(events, []);
    if (kind === "emergency") assert.equal(answer.text, rulesCopy[language].emergency);
    if (kind === "private") {
      assert.match(answer.text, /لا يمكن إلغاء الموعد من الدردشة/u);
      assert.equal(answer.page, "/account");
    }
    if (kind === "unrelated") assert.match(answer.text, /Cedar’s clinics/u);
  });
}
