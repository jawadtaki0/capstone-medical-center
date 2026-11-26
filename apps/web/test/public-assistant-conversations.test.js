import assert from "node:assert/strict";
import { test } from "node:test";
import { liveGemini } from "./gemini-live-fixture.js";
import { cedarToday, createAssistant } from "../server/public-assistant.js";
import {
  requestSelectionUrl,
  validatedPreselection,
} from "../src/request-selection.js";

// Tuesday in Beirut, Monday in UTC.
const now = Date.parse("2026-11-23T22:30:00Z");
const today = cedarToday(new Date(now));
const tomorrow = "2026-11-25";
const friday = "2026-11-27";
const saturday = "2026-11-28";
const rowsFor = (date) =>
  ["Cardiology", "Dermatology"].flatMap((specialty) =>
    ["10:00", "15:00"].map((startTime, i) => ({
      date,
      specialty,
      startTime,
      endTime: i ? "16:00" : "11:00",
      professionalName: "Dr. " + specialty + " Example",
      professionalId: "fictional-" + specialty.toLowerCase(),
      sourceSessionId: specialty + "-" + i,
      appointmentRequired: true,
    })),
  );
const live = process.env.CEDAR_ASSISTANT_CASES_LIVE === "1";
if (live && !process.env.GEMINI_API_KEY)
  throw new Error("Configure GEMINI_API_KEY privately before the live run.");
function scenario(t, { empty = false } = {}) {
  let revoked = false;
  let messages = [];
  let searchContext;
  let calls = [];
  const observe = (event) => {
    if (live) t.diagnostic(JSON.stringify(event));
  };
  const provider = live
    ? liveGemini(observe)
    : async () => {
        throw new Error("Gemini unavailable in this run");
      };
  const schedule = (date) =>
    revoked || empty
      ? rowsFor(date).map((row) => ({ ...row, published: false }))
      : rowsFor(date);
  const model = async (input) => {
    calls.push(input.facts ? "compose" : "interpret");
    return provider(input);
  };
  const assistant = createAssistant({
    today: () => today,
    now: () => now,
    interpret: model,
    compose: model,
    observe,
    readSessions: async (date) => schedule(date),
  });
  return {
    revoke: () => {
      revoked = true;
    },
    async ask(
      message,
      route,
      { language = "en", filters, starts, match, page } = {},
    ) {
      messages = [...messages, message].slice(-8);
      calls = [];
      const answer = await assistant({ language, messages, searchContext });
      searchContext = answer.searchContext;
      const context = searchContext
        ? JSON.parse(Buffer.from(searchContext.split(".")[0], "base64url"))
        : null;
      const cards = answer.cards ?? [];
      t.diagnostic(
        JSON.stringify({
          route: answer.kind,
          filters: context?.filters ?? context?.pendingTime ?? null,
          cards: cards.map(({ date, start, id }) => id ?? [date, start]),
          clarification: ["clarify", "chooseSession"].includes(answer.kind),
          fallback: answer.fallback === true || (!live && calls.length > 0),
          geminiCalls: live ? calls : [],
          unavailableCalls: live ? [] : calls,
          geminiComposed:
            live && calls.includes("compose") && answer.fallback === false,
        }),
      );
      assert.equal(answer.kind, route);
      if (filters)
        for (const [key, value] of Object.entries(filters))
          assert.equal(context?.filters?.[key], value, key);
      if (starts)
        assert.deepEqual(
          cards.map(({ start }) => start),
          starts,
        );
      if (match)
        for (const pattern of match)
          assert.ok(
            pattern.test(answer.text),
            "Expected reply facts for " + route,
          );
      if (page) assert.equal(answer.page, page);
      for (const card of cards.filter(({ href }) => href)) {
        const rows = schedule(card.date);
        const row = rows.find(
          (item) =>
            item.published !== false && requestSelectionUrl(item) === card.href,
        );
        assert.ok(row, "card must use a current published record");
        assert.ok(
          validatedPreselection(
            new URL(card.href, "https://example.invalid").search,
            rows,
          ),
        );
      }
      return answer;
    },
  };
}

for (const variation of [false, true]) {
  const named = (name, fn) =>
    test(name + (variation ? " (alternate wording)" : ""), fn);
  named(
    "change time and then weekday without dropping the specialty",
    async (t) => {
      const { ask } = scenario(t);
      const first = variation
        ? "Could I see a heart specalist tmrw?"
        : "Heart dr tomoorow?";
      await ask(first, "sessions", {
        filters: { specialty: "Cardiology", from: tomorrow },
        starts: ["10:00", "15:00"],
      });
      await ask(variation ? "ba3d l 3?" : "بعد ال3؟", "sessions", {
        filters: { from: tomorrow, after: "15:00" },
        starts: ["15:00"],
      });

      await ask(
        variation ? "Actually, Saturday." : "Actually, Friday.",
        "sessions",
        {
          filters: {
            specialty: "Cardiology",
            from: variation ? saturday : friday,
            after: "15:00",
          },
          starts: ["15:00"],
        },
      );
    },
  );
  named("replace specialty and then time window", async (t) => {
    const { ask } = scenario(t);
    await ask(
      variation ? "بكرا دكتور قلب بعد الساعة ٣؟" : "في دكتور قلب بكرا بعد ال٣؟",
      "sessions",
      { language: "ar", starts: ["15:00"] },
    );
    await ask(
      variation ? "How about dermatology?" : "Actually, dermatology.",
      "sessions",
      {
        filters: { specialty: "Dermatology", from: tomorrow, after: "15:00" },
        starts: ["15:00"],
      },
    );
    await ask(
      variation ? "الصبح بدلًا من ذلك" : "Morning instead.",
      "sessions",
      {
        filters: {
          specialty: "Dermatology",
          from: tomorrow,
          before: "12:00",
          after: "",
        },
        starts: ["10:00"],
      },
    );
  });
  named("clarify a fresh fragment and remember its time", async (t) => {
    const { ask } = scenario(t);
    await ask(variation ? "ba3d 3?" : "بعد ال3؟", "clarify", { starts: [] });
    await ask(variation ? "2alb bukra" : "قلب بكرا", "sessions", {
      filters: { specialty: "Cardiology", from: tomorrow, after: "15:00" },
      starts: ["15:00"],
    });
  });
  named("empty published schedule states the actual filters", async (t) => {
    const { ask } = scenario(t, { empty: true });
    await ask(
      variation
        ? "bukra doktor 2alb ba3d 3?"
        : "fi doctor 2alb bukra ba3d l 3?",
      "empty",
      {
        filters: { specialty: "Cardiology", from: tomorrow, after: "15:00" },
        starts: [],
        match: [/cardiology/i, /tomorrow/i, /15:00/],
      },
    );
  });
  named(
    "lab comparison and preparation retain both catalogue entries",
    async (t) => {
      const { ask } = scenario(t);
      const comparison = await ask(
        variation
          ? "FBG versus glycated hemoglobin?"
          : "What’s the difference between fasting glucose and HbA1c?",
        "labs",
      );
      assert.deepEqual(
        comparison.cards.map(({ id }) => id),
        ["fasting-glucose", "hba1c"],
      );
      assert.match(comparison.cards[0].description, /fast/i);
      assert.match(comparison.cards[1].description, /two to three months/i);
      await ask(
        variation ? "Which one needs fasting?" : "وأي واحد بده صيام؟",
        "labs",
        {
          language: variation ? "en" : "ar",
          starts: [],
          match: variation
            ? [
                /fasting glucose requires fasting/i,
                /HbA1c.*not usually/i,
                /Reception/i,
              ]
            : [/الصائم.*الصيام/, /لا يتطلب.*HbA1c/, /الاستقبال/],
        },
      );
      await ask(
        variation ? "شو يعني نتيجتي؟" : "What does my result mean?",
        "clinical",
        { starts: [] },
      );
    },
  );
  named(
    "public topic change clears search and private status points to the portal",
    async (t) => {
      const { ask } = scenario(t);
      await ask("Heart doctor tomorrow?", "sessions");
      await ask(
        variation
          ? "Tell me about pure-tone hearing tests"
          : "What is Audiometry?",
        "library",
        { starts: [], page: "/services/audiometry" },
      );
      await ask(variation ? "بعد ال3؟" : "After 3?", "clarify", { starts: [] });
      await ask(
        variation
          ? "Where can I see my lab reports?"
          : "Are my lab results ready?",
        "private",
        {
          starts: [],
          page: "/account#lab-results",
          match: [/can’t access|cannot access/i],
        },
      );
    },
  );
  named(
    "booking handoff requires a specific published selection",
    async (t) => {
      const { ask, revoke } = scenario(t);
      await ask("Heart doctor tomorrow?", "sessions");
      const booking = variation
        ? "Can you reserve that slot?"
        : "Can you book me in with that doctor?";
      await ask(booking, "chooseSession", {
        starts: [],
        match: [/which session/i],
      });
      await ask(
        variation ? "The 15:00 session please" : "The 3pm one",
        "sessions",
        { starts: ["15:00"], match: [/Reception.*confirms/i] },
      );
      await ask(booking, "sessions", {
        starts: ["15:00"],
        match: [/Reception.*confirms/i],
      });
      revoke();
      // Use an unexpired search to verify selection is rechecked at handoff.
      const stale = scenario(t);
      await stale.ask("Heart doctor tomorrow?", "sessions");
      stale.revoke();
      await stale.ask("The 3pm one", "empty", { starts: [] });
    },
  );
}
