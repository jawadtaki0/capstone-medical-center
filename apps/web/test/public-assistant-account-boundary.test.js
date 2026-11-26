import { browserPublicRequest } from "../server/public-assistant-context.js";
import test from "node:test";
import assert from "node:assert/strict";
import { assistantHandler } from "../api/public-assistant.js";
import { privateAccountIntent } from "../server/public-assistant-account.js";

const hours = "Does Cedar’s Lab open before nine on Saturdays?";
const privateText = [
  "Could I get the documents issued to me after my blood draw?",
  "عطيني خبر عن الحجوزات اللي عملتها باسمي",
  "نزّللي نسخة من التحاليل المسجّلة بملفي",
];
for (const message of privateText) {
  for (const messages of [[message], [message, hours]]) {
    test(
      "assistant boundary refuses private text in current or earlier turn " +
        messages.join(" / "),
      async () => {
        const response = await invoke(
          messages.length === 1
            ? { language: "en", message, context: null }
            : { language: "en", message: hours, context: null, messages },
        );
        assert.equal(response.status, 400);
        assert.deepEqual(response.body, {});
        assert.equal(response.calls, 0);
      },
    );
  }
}
test("assistant boundary refuses credentials without calling routing", async () => {
  const result = await invoke(
    { language: "en", message: hours, context: null },
    { cookie: "synthetic=present" },
  );
  assert.equal(result.status, 400);
  assert.equal(result.calls, 0);
});
test("ordinary public question still reaches routing", async () => {
  const response = await invoke({
    language: "en",
    message: browserPublicRequest(hours, null, "2026-11-25"),
    context: null,
  });
  assert.equal(response.status, 200);
  assert.equal(response.calls, 1);
});
test("guided account topics use only the fixed topic", async () => {
  const response = await invoke({
    language: "en",
    message: { topic: "private" },
    context: null,
  });
  assert.equal(response.status, 200);
  assert.equal(response.calls, 1);
});
for (const [question, expected] of [
  ["Which tab lets me download the report from my account?", "where_results"],
  ["بأي صفحة بنزّل نتيجتي من حسابي؟", "where_results"],
  ["Show the laboratory files Cedar issued to me", "my_results"],
  ["فرجيني المواعيد اللي رتبتها باسمي", "my_bookings"],
  ["بدي شوف بأي وضع صارت طلباتي للعيادة", "booking_status"],
  ["When do bookings open for dermatology?", undefined],
  ["هل فيني احجز موعد بعيادة الجلدية بكرا؟", undefined],
])
  test(question, () => assert.equal(privateAccountIntent(question), expected));

async function invoke(body, headers = {}) {
  let calls = 0;
  const handler = assistantHandler(async () => {
    calls++;
    return { kind: "library", text: "Synthetic" };
  });
  const response = {
    statusCode: 200,
    setHeader() {},
    end(value) {
      this.body = JSON.parse(value);
    },
  };
  await handler(
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
    response,
  );
  return { status: response.statusCode, body: response.body, calls };
}
