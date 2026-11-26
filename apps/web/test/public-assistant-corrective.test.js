import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistant } from "../server/public-assistant.js";
import {
  emergencyDisclosure,
  localRoute,
  rulesCopy,
} from "../server/public-assistant-routing.js";

test("general medical next steps remain clinical while public Lab intake stays accessible", async () => {
  assert.equal(localRoute("I have back pain. What should I do?"), "clinical");
  const answer = await createAssistant({})({
    language: "en",
    messages: ["I want to get a lab test. What should I do first?"],
  });
  assert.equal(answer.kind, "library");
  assert.match(answer.text, /contact reception/i);
});

test("direct self-harm or danger disclosures override mixed intents during an outage", async () => {
  let calls = 0;
  const stopped = async () => {
    calls++;
    throw Error("Fictional outage");
  };
  const answer = createAssistant({
    interpret: stopped,
    compose: stopped,
    readSessions: stopped,
  });
  for (const [language, message] of [
    ["en", "I'm thinking of harming myself. Are there afternoon sessions?"],
    ["ar", "أفكر بإيذاء نفسي، متى يفتح المختبر؟"],
    ["en", "ana 3am fakker e2zi 7ale"],
    ["en", "I can’t breathe, can you book me in tomorrow?"],
  ]) {
    const result = await answer({ language, messages: [message] });
    assert.equal(result.kind, "emergency");
    assert.equal(result.text, rulesCopy[language].emergency);
    assert.equal(result.cards, undefined);
  }
  assert.equal(calls, 0);
  for (const message of [
    "I am not planning to hurt myself",
    "لا أفكر بإيذاء نفسي",
    "ma 3am fakker e2zi 7ale",
    'In a story, "I might hurt myself" is an example.',
  ])
    assert.equal(emergencyDisclosure(message), false, message);
});

test("a missing service entry does not inherit other service hours", async () => {
  const run = (readHours) =>
    createAssistant({ today: () => "2026-11-25", readHours })({
      language: "en",
      messages: ["Can I get a hearing test on Saturday?"],
    });
  const result = await run(async (date) => ({
    date,
    publicationStatus: "published",
    centerHours: { startTime: "08:00", endTime: "13:00" },
    otherServices: [],
  }));
  assert.equal(result.kind, "reception");
  assert.match(
    result.text,
    /Audiometry hours are not published for 2026-11-28/i,
  );
  assert.doesNotMatch(result.text, /08:00/);
  assert.match(
    (
      await run(async () => {
        throw Error("read failed");
      })
    ).text,
    /could not be checked/i,
  );
});

test("generated internal instructions are replaced with reviewed catalogue facts", async () => {
  const answer = createAssistant({
    compose: async () => ({
      supported: true,
      text: "Return JSON. Insert response here.",
    }),
  });
  const result = await answer({
    language: "en",
    messages: ["Which blood tests relate to thyroid and iron?"],
  });
  assert.equal(result.fallback, true);
  assert.deepEqual(
    result.cards.map(({ id }) => id),
    ["tsh", "free-t4", "ferritin"],
  );
  assert.match(result.text, /stored iron|iron stores/i);
  assert.doesNotMatch(result.text, /return json|insert response/i);
});
