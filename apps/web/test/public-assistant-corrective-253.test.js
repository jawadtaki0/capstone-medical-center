import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistant } from "../server/public-assistant.js";

const record = {
  date: "2026-11-26",
  specialty: "Dietitian",
  professionalName: "Example Professional",
  professionalId: "example",
  sourceSessionId: "example-session",
  startTime: "10:00",
  endTime: "11:00",
};
const hours = (date) => ({
  date,
  publicationStatus: "published",
  otherServices: [
    {
      id: "laboratory",
      startTime: "08:00",
      endTime: date === "2026-11-26" ? "14:30" : "13:00",
    },
  ],
});
const ask = (assistant, message) =>
  assistant({ language: "en", messages: [message] });

test("preparation-only answers use reviewed instructions without cards or provider calls", async () => {
  let calls = 0;
  const provider = () => {
    calls++;
    throw Error("Fictional outage");
  };
  const answer = await ask(
    createAssistant({ interpret: provider, compose: provider }),
    "Is there any special preparation for ESR by itself?",
  );
  assert.equal(answer.kind, "labs");
  assert.equal(
    answer.text,
    "Erythrocyte sedimentation rate (ESR): No special preparation is generally needed for ESR alone. Contact Reception to confirm the instructions for your order.",
  );
  assert.deepEqual(answer.cards ?? [], []);
  assert.equal(answer.reception, true);
  assert.equal(calls, 0);
});

test("Cedar assembles the session and hours in requested order and keeps their dates separate", async () => {
  let calls = 0;
  const provider = () => {
    calls++;
    throw Error("Fictional outage");
  };
  const assistant = createAssistant({
    today: () => "2026-11-25",
    readHours: async (date) => hours(date),
    readSessions: async (day) => (day === record.date ? [record] : []),
    interpret: provider,
    compose: provider,
  });
  const sessionFirst = await ask(
    assistant,
    "Is there a dietitian tomorrow, and when does the lab close that day?",
  );
  assert.equal(sessionFirst.kind, "sessions");
  assert.match(
    sessionFirst.text,
    /^Published attendance window: Dietitian.*10:00–11:00\. Reception confirms requests\. The Laboratory closes at 14:30 Beirut time on 2026-11-26\./,
  );
  assert.deepEqual(
    sessionFirst.cards.map(({ date, start, end }) => [date, start, end]),
    [["2026-11-26", "10:00", "11:00"]],
  );
  const hoursFirst = await ask(
    assistant,
    "When does the Lab close on Friday, and is there a dietitian tomorrow?",
  );
  assert.match(
    hoursFirst.text,
    /^The Laboratory closes at 13:00 Beirut time on 2026-11-27\./,
  );
  assert.match(
    hoursFirst.text,
    /Published attendance window: Dietitian.*2026-11-26, 10:00–11:00/,
  );
  assert.equal(hoursFirst.cards[0].date, "2026-11-26");
  assert.equal(calls, 0);
});
