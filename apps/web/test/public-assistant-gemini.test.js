import assert from "node:assert/strict";
import { test } from "node:test";
import { liveGemini } from "./gemini-live-fixture.js";
import {
  createAssistant,
  geminiAssistant,
} from "../server/public-assistant.js";

const live = process.env.CEDAR_ASSISTANT_CASES_LIVE === "1";
const comparison = "What is the difference between fasting glucose and HbA1c?";
const candidate = (value) =>
  Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
  });

test(
  "live fresh lab comparison uses interpretation and grounded composition",
  { skip: !live },
  async (t) => {
    const observe = (event) => t.diagnostic(JSON.stringify(event));
    const model = liveGemini(observe);
    let interpreted = false;
    let grounded = false;
    const answer = await createAssistant({
      observe,
      interpret: async (input) => {
        const intent = await model(input);
        interpreted =
          intent?.kind === "labs" &&
          intent.tests?.length === 2 &&
          ["cbc", "esr"].every((id) => intent.tests.includes(id));
        observe({
          stage: "interpretation",
          outcome: interpreted ? "accepted" : "rejected",
          labRoute: intent?.kind === "labs",
          testCount: Array.isArray(intent?.tests) ? intent.tests.length : 0,
          knownIds: ["cbc", "esr"].filter((id) => intent?.tests?.includes(id)),
        });
        return intent;
      },
      compose: async (input) => {
        const facts = input.facts.filter((fact) => typeof fact === "object");
        grounded = ["cbc", "esr"].every((id) =>
          facts.some((fact) => fact.id === id && fact.description),
        );
        observe({
          stage: "grounding",
          outcome: grounded ? "accepted" : "rejected",
        });
        return model(input);
      },
    })({
      language: "en",
      messages: [
        "How does a complete blood count differ from the erythrocyte sedimentation rate test?",
      ],
    });
    assert.ok(interpreted, "Gemini must select both catalogue IDs");
    assert.equal(answer.kind, "labs");
    assert.ok(grounded, "Send both reviewed catalogue facts to composition");
    assert.equal(answer.fallback, false, "Use validated Gemini prose");
    assert.ok(
      /blood cells?|blood cell|platelets/i.test(answer.text) &&
        /settl|sediment/i.test(answer.text),
      "Preserve both reviewed test facts",
    );
  },
);

test("live controlled English comparison", { skip: !live }, async (t) => {
  assert.ok(process.env.GEMINI_API_KEY, "Configure the key privately");
  const events = [];
  const observe = (event) => {
    events.push(event);
    t.diagnostic(JSON.stringify(event));
  };
  const model = liveGemini(observe);
  const input = {
    language: "en",
    messages: [comparison],
    sessionSearch: false,
  };
  // The actual comparison route uses an exact reviewed pair and bypasses interpretation.
  // Probe interpretation separately while still attempting the actual composition if it fails.
  try {
    const intent = await model(input);
    const interpreted =
      intent?.kind === "labs" &&
      ["fasting-glucose", "hba1c"].every((id) => intent.tests?.includes(id));
    observe({
      stage: "interpretation",
      outcome: interpreted ? "accepted" : "rejected",
    });
  } catch {
    // The adapter has emitted a sanitized reason.
  }
  const answer = await createAssistant({
    interpret: model,
    compose: model,
    observe,
  })(input);
  assert.ok(
    events.some(
      ({ stage, outcome }) => stage === "composition" && outcome === "accepted",
    ),
    "English composition must be accepted",
  );
  assert.equal(answer.fallback, false);
  assert.ok(
    answer.text !==
      answer.cards
        .map(({ name, description }) => name + ": " + description)
        .join(" "),
    "English reply must use composed text",
  );
  assert.ok(
    /fast/i.test(answer.text) &&
      /(?:two|2).{0,12}(?:three|3)\s+months/i.test(answer.text),
    "English composition must preserve both approved facts",
  );
});

test(
  "live eligible Arabic reply uses grounded Gemini text",
  { skip: !live },
  async (t) => {
    assert.ok(process.env.GEMINI_API_KEY, "Configure the key privately");
    const observe = (event) => t.diagnostic(JSON.stringify(event));
    const model = liveGemini(observe);
    const answer = await createAssistant({
      interpret: model,
      compose: model,
      observe,
    })({
      language: "ar",
      messages: ["ما هو قياس السمع بالنغمات النقية؟"],
    });
    assert.equal(answer.kind, "library");
    assert.equal(answer.fallback, false, "Arabic reply must use composition");
    assert.ok(
      /تردد/.test(answer.text) && /سمع/.test(answer.text),
      "Arabic composition must preserve approved hearing and frequency facts",
    );
  },
);

test("adapter distinguishes HTTP, timeout and malformed output without logging bodies", async () => {
  for (const [request, expected] of [
    [
      async () =>
        new Response("fictional confidential response", { status: 429 }),
      { outcome: "http", status: 429 },
    ],
    [
      async () => {
        throw new DOMException(
          "fictional confidential timeout",
          "TimeoutError",
        );
      },
      { outcome: "timeout" },
    ],
    [
      async () => new Response("fictional malformed output"),
      { outcome: "malformed" },
    ],
  ]) {
    const events = [];
    const model = geminiAssistant({
      key: "fictional",
      request,
      observe: (event) => events.push(event),
    });
    await assert.rejects(
      model({ facts: [] }),
      /^Error: Assistant model unavailable\.$/,
    );
    assert.deepEqual(
      events,
      expected.outcome === "timeout"
        ? [
            { stage: "composition", ...expected },
            { stage: "composition", outcome: "retry_attempted" },
            { stage: "composition", ...expected },
          ]
        : [{ stage: "composition", ...expected }],
    );
  }
});

test("transient failures recover once, without retrying a rate limit or exhausting the turn deadline", async () => {
  for (const initial of ["503", "timeout", "429", "short deadline"]) {
    let calls = 0;
    const events = [];
    const model = geminiAssistant({
      key: "fictional",
      observe: ({ outcome }) => events.push(outcome),
      request: async () => {
        if (++calls > 1)
          return candidate({ supported: true, text: "Reviewed fact" });
        if (initial === "timeout")
          throw new DOMException("Timeout", "TimeoutError");
        return new Response(null, { status: initial === "429" ? 429 : 503 });
      },
    });
    const result = model(
      { facts: [] },
      initial === "short deadline" ? { deadline: Date.now() + 650 } : {},
    );
    if (initial === "429" || initial === "short deadline") {
      await assert.rejects(result);
      assert.equal(calls, 1);
      if (initial === "short deadline")
        assert.ok(events.includes("retry_skipped_deadline"));
    } else {
      assert.equal((await result).supported, true);
      assert.equal(calls, 2);
      assert.equal(events.at(-1), "retry_recovered");
    }
  }
});

test("Cedar validation distinguishes a parsed rejection from provider failure", async () => {
  const events = [];
  const observe = (event) => events.push(event);
  const model = geminiAssistant({
    key: "fictional",
    request: async () => candidate({ supported: true, text: 42 }),
    observe,
  });
  const answer = await createAssistant({
    interpret: model,
    compose: model,
    observe,
  })({
    language: "en",
    messages: [comparison],
  });
  assert.equal(answer.fallback, true);
  assert.deepEqual(
    answer.cards.map(({ id }) => id),
    ["fasting-glucose", "hba1c"],
  );
  assert.deepEqual(events, [
    { stage: "composition", outcome: "parsed" },
    { stage: "composition", outcome: "rejected", reason: "shape" },
  ]);
});

test("an unsupported comparison keeps the approved facts and cards", async () => {
  const observe = [];
  const model = geminiAssistant({
    key: "fictional",
    request: async () => candidate({ supported: false }),
    observe: (event) => observe.push(event),
  });
  const answer = await createAssistant({
    interpret: model,
    compose: model,
    observe: (event) => observe.push(event),
  })({ language: "en", messages: [comparison] });
  assert.equal(answer.fallback, true);
  assert.deepEqual(
    answer.cards.map(({ id }) => id),
    ["fasting-glucose", "hba1c"],
  );
  assert.deepEqual(
    observe.map(({ outcome }) => outcome),
    ["parsed", "unsupported"],
  );
});

test("emergency, private status and clinical routes bypass both Gemini stages", async () => {
  let calls = 0;
  const model = () => {
    calls++;
  };
  const events = [];
  const assistant = createAssistant({
    interpret: model,
    compose: model,
    observe: (event) => events.push(event),
  });
  for (const [message, kind] of [
    ["I can't breathe", "emergency"],
    ["Are my lab results ready?", "private"],
    ["What does my result mean?", "clinical"],
  ]) {
    const answer = await assistant({ language: "en", messages: [message] });
    assert.equal(answer.kind, kind);
    assert.equal(answer.cards, undefined);
  }
  assert.deepEqual(events, []);
  assert.equal(calls, 0);
});

test("a specialty search does not inherit a provider-invented professional", async () => {
  const date = "2026-11-25";
  const assistant = createAssistant({
    today: () => "2026-11-24",
    interpret: async () => ({
      kind: "sessions",
      professional: "heart specialist",
    }),
    readSessions: async () => [
      {
        date,
        professionalId: "fictional",
        sourceSessionId: "session",
        professionalName: "Dr. Example",
        specialty: "Cardiology",
        startTime: "15:00",
        endTime: "16:00",
      },
    ],
  });
  const answer = await assistant({
    language: "en",
    messages: ["Could I see a heart specialist tomorrow?"],
  });
  assert.equal(answer.cards?.[0]?.professional, "Dr. Example");
});

test("clear generic Arabizi availability survives a rejected interpretation", async () => {
  const answer = await createAssistant({
    today: () => "2026-11-24",
    interpret: async () => ({ kind: "reception" }),
    readSessions: async (date) => [
      {
        date,
        professionalId: "fictional",
        sourceSessionId: "session",
        professionalName: "Dr. Example",
        specialty: "Dermatology",
        startTime: "15:00",
        endTime: "16:00",
      },
    ],
  })({ language: "en", messages: ["doctor bukra pls?"] });
  assert.equal(answer.cards?.[0]?.date, "2026-11-25");
  assert.equal(answer.cards?.[0]?.specialty, "Dermatology");
});
