import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistant,
  geminiAssistant,
} from "../server/public-assistant.js";
import { validatedPreselection } from "../src/request-selection.js";

const date = "2026-11-26";
const morning = {
  date,
  professionalName: "Dr. Rowan Example",
  specialty: "Cardiology",
  professionalId: "rowan",
  sourceSessionId: "am",
  startTime: "10:00",
  endTime: "11:00",
};
const afternoon = {
  ...morning,
  sourceSessionId: "pm",
  startTime: "15:00",
  endTime: "16:00",
};
const make = (interpret, readSessions = async () => [morning, afternoon]) =>
  createAssistant({ interpret, readSessions, today: () => "2026-11-24" });
const ask = (assistant, ...messages) => assistant({ language: "en", messages });

test("follow-up uses the conversation and returns only matching published records", async () => {
  const assistant = make(
    ({ messages }) => {
      assert.equal(messages[0], "Cardiology on 2026-11-26");
      return {
        kind: "sessions",
        specialty: "Cardiology",
        from: date,
        through: date,
        after: "12:00",
      };
    },
    async (queryDate) => {
      assert.equal(queryDate, date);
      return [
        morning,
        afternoon,
        { ...afternoon, sourceSessionId: "draft", published: false },
        { ...afternoon, sourceSessionId: "closed", available: false },
        { ...afternoon, date: "2026-11-27" },
      ];
    },
  );
  const first = await ask(assistant, "Cardiology on 2026-11-26");
  const response = await assistant({
    language: "en",
    messages: ["Cardiology on 2026-11-26", "Afternoon only"],
    searchContext: first.searchContext,
  });
  assert.equal(response.cards.length, 1);
  const search = new URL(response.cards[0].href, "http://example.invalid")
    .search;
  assert.equal(validatedPreselection(search, [morning, afternoon]), afternoon);
  assert.equal(validatedPreselection(search, [morning]), null);
  assert.equal(
    validatedPreselection(search, [{ ...afternoon, startTime: "15:30" }]),
    null,
  );
});

test("Arabic responses, empty and unavailable schedules do not invent cards", async () => {
  const intent = () => ({
    kind: "sessions",
    specialty: "missing",
    from: date,
    through: date,
  });
  const ar = await make(intent)({
    language: "ar",
    messages: ["هل يوجد طبيب جلدية غدا؟"],
  });
  assert.equal(ar.kind, "empty");
  assert.match(ar.text, /لا توجد/);
  assert.equal(ar.cards, undefined);
  assert.equal(
    (
      await ask(
        make(intent, async () => {
          throw Error();
        }),
        "Any sessions tomorrow?",
      )
    ).kind,
    "unavailable",
  );
});

test("educational comparison resolves approved IDs and omits unsupported claims", async () => {
  const result = await ask(
    make(() => ({
      kind: "labs",
      compare: true,
      tests: ["cbc", "esr"],
      text: "invented",
    })),
    "Compare CBC and ESR",
  );
  assert.equal(result.cards.length, 2);
  assert.ok(
    result.cards.every((card) =>
      card.source.startsWith("https://medlineplus.gov/"),
    ),
  );
  assert.doesNotMatch(result.text, /invented/);
  assert.equal(
    (
      await ask(
        make(() => ({ kind: "labs", tests: ["cbc", "not-public"] })),
        "Lab tests",
      )
    ).kind,
    "reception",
  );
});

test("private and clinical questions stay out of the provider and failure is safe", async () => {
  let calls = 0;
  const assistant = make(({ messages }) => {
    calls++;
    assert.deepEqual(messages, ["Clinic"]);
    throw Error("private provider payload");
  });
  for (const query of [
    "My report status",
    "Diagnose these symptoms",
    "My email is test@example.invalid",
    "موعدي",
    "هل أتناول الدواء؟",
  ])
    assert.match((await ask(assistant, query)).kind, /^(private|clinical)$/);
  assert.equal(calls, 0);
  const result = await ask(assistant, "My report status", "Clinic");
  assert.equal(result.kind, "failure");
  assert.doesNotMatch(result.text, /payload/);
});

test("Gemini key stays in server header and model response is JSON", async () => {
  const interpret = geminiAssistant({
    key: "fictional-server-key",
    request: async (url, options) => {
      assert.equal(
        url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      );
      assert.equal(options.headers["x-goog-api-key"], "fictional-server-key");
      assert.doesNotMatch(options.body, /fictional-server-key/);
      return Response.json({
        candidates: [{ content: { parts: [{ text: '{"kind":"clinic"}' }] } }],
      });
    },
  });
  assert.deepEqual(await interpret({ messages: ["Clinic"], language: "en" }), {
    kind: "clinic",
  });
});

test("published sessions use Cedar wording and keep the verified request link", async () => {
  let compositions = 0;
  const response = createAssistant({
    today: () => "2026-11-24",
    interpret: async () => ({ kind: "sessions", from: date, through: date }),
    readSessions: async () => [morning],
    compose: async () => {
      compositions++;
      return {
        supported: true,
        text: "Your visit is guaranteed at 10:00.",
        cards: [{ href: "https://example.invalid" }],
      };
    },
  });
  const answer = await ask(response, "Any times to see the heart doctor?");
  assert.equal(
    answer.text,
    "These are published attendance windows. The request form checks the current schedule, and Reception confirms requests.",
  );
  assert.equal(compositions, 0);
  assert.match(answer.cards[0].href, /^\/request\?/);
});

test("unrelated weather skips provider; unsupported composition offers Reception", async () => {
  let classified = 0;
  const answer = createAssistant({
    interpret: async () => {
      classified++;
      return { kind: "clinic" };
    },
    compose: async () => ({ supported: false }),
  });
  assert.equal(
    (await ask(answer, "How is the weather tomorrow?")).kind,
    "unrelated",
  );
  assert.equal(classified, 0);
  assert.equal(
    (await ask(answer, "What is Cedar’s Clinic price?")).kind,
    "reception",
  );
});
