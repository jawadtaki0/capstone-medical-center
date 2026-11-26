import test from "node:test";
import assert from "node:assert/strict";
import { assistantHandler } from "../api/public-assistant.js";
import * as context from "../server/public-assistant-context.js";

test("the API rejects even harmless raw text and unknown nested fields", async () => {
  let calls = 0;
  const handler = assistantHandler(async () => {
    calls++;
    return { kind: "library" };
  });
  for (const message of [
    "Cedar opening hours?",
    { intent: "hours", service: "laboratory", text: "sample" },
    { menu: { topic: "hours", choice: "sample" } },
  ]) {
    const response = { statusCode: 200, setHeader() {}, end() {} };
    await handler(
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { language: "en", message, context: null },
      },
      response,
    );
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("browser resolves hours and refinements to canonical fields in both languages", () => {
  const prior = {
    lastIntent: "hours",
    service: "laboratory",
    date: "2026-11-27",
    specialty: null,
    clinicianId: null,
  };
  for (const [input, service] of [
    ["When does the lab start and finish on Saturday?", "laboratory"],
    ["طيب والسبت شو الدوام؟", "laboratory"],
    ["And Audiometry for the same day?", "audiometry"],
    ["وكمان فحوصات السمع بهالنهار؟", "audiometry"],
  ]) {
    const same = service === "audiometry";
    const date = same ? "2026-11-27" : "2026-11-28";
    assert.deepEqual(context.browserPublicRequest(input, prior, "2026-11-25"), {
      intent: "hours",
      service,
      date,
    });
  }
});

test("an uncertain request cannot produce a public command or transcript text", () => {
  assert.equal(
    context.browserPublicRequest(
      "Could I get what came back from the thing they took from me?",
      null,
      "2026-11-25",
    ),
    null,
  );
});
