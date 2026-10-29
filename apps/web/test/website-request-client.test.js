import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequestClient,
  createSubmissionAttempt,
} from "../src/website-request-client.js";

test("review client sends one private same-origin JSON request without retrying", async () => {
  const calls = [];
  const client = createRequestClient({
    request: async (...args) => {
      calls.push(args);
      return new Response(
        JSON.stringify({
          reference: "WR-SYNTHETIC",
          trackingToken: "A".repeat(43),
        }),
      );
    },
  });
  const payload = {
    submissionKey: "dummy-key",
    patient: { firstName: "Synthetic" },
  };
  assert.deepEqual(await client("submit", payload), {
    reference: "WR-SYNTHETIC",
    trackingToken: "A".repeat(43),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/requests/submit");
  assert.equal(calls[0][1].body, JSON.stringify(payload));
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(calls[0][1].referrerPolicy, "no-referrer");
  assert.equal(calls[0][1].redirect, "error");
});

test("hosted client uses only its fixed HTTPS Render origin without cookies or renderer-supplied destinations", async () => {
  let called;
  const client = createRequestClient({
    apiOrigin: "https://cedar-review-example.onrender.com",
    request: async (...args) => {
      called = args;
      return new Response("[]");
    },
  });
  await client("sessions?date=2026-11-02");
  assert.equal(
    called[0],
    "https://cedar-review-example.onrender.com/api/requests/sessions?date=2026-11-02",
  );
  assert.equal(called[1].credentials, "omit");
  assert.equal(called[1].redirect, "error");
  assert.equal(called[1].referrerPolicy, "no-referrer");
  assert.equal(Object.hasOwn(called[1].headers, "Authorization"), false);
  for (const apiOrigin of [
    "https://example.com",
    "http://cedar-review-example.onrender.com",
    "http://localhost:4000",
    "https://cedar-review-example.onrender.com/",
    "https://cedar-review-example.onrender.com/path",
    "https://cedar-review-example.onrender.com?target=other",
    "https://cedar-review-example.onrender.com#fragment",
    "https://name:secret@cedar-review-example.onrender.com",
    "https://cedar-review-example.onrender.com:443",
    "https://extra.cedar-review-example.onrender.com",
    "https://-invalid.onrender.com",
  ])
    assert.throws(
      () => createRequestClient({ apiOrigin }),
      /Invalid review API origin/,
    );
});

test("cold-start HTML, malformed JSON and provider errors are controlled and never retried", async () => {
  for (const response of [
    new Response("<h1>Provider waking page</h1>", { status: 503 }),
    new Response("<h1>Provider waking page</h1>", { status: 200 }),
    new Response('{"private-provider-detail":', { status: 502 }),
  ]) {
    let calls = 0;
    const client = createRequestClient({
      request: async () => (++calls, response),
    });
    await assert.rejects(
      client("submit", { submissionKey: "dummy" }),
      (error) => {
        assert.equal(error.code, "request_unavailable");
        assert.match(error.message, /waking|unavailable/);
        assert.match(error.message, /same receipt/);
        assert.equal(error.message.includes("Provider"), false);
        assert.match(error.forLanguage("ar"), /خادم العرض/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("network exceptions reveal no destination/token while preserving a retryable outcome", async () => {
  const client = createRequestClient({
    request: async () => {
      throw Error("https://private-host/token-secret");
    },
  });
  await assert.rejects(client("track", { token: "dummy-token" }), (error) => {
    assert.equal(error.code, "request_unavailable");
    assert.equal(error.message.includes("token-secret"), false);
    assert.equal(error.message.includes("https://"), false);
    return true;
  });
});

test("HTTP success without a valid catalogue or private receipt never becomes false UI success", async () => {
  for (const [action, data] of [
    ["sessions?date=2026-11-02", {}],
    ["professionals?date=2026-11-02", {}],
    ["submit", { reference: "WR-SYNTHETIC" }],
    ["track", { reference: "WR-SYNTHETIC", status: "invented" }],
  ]) {
    const client = createRequestClient({
      request: async () => new Response(JSON.stringify(data)),
    });
    await assert.rejects(
      client(action, action === "submit" || action === "track" ? {} : null),
      { code: "request_unavailable" },
    );
  }
});

test("bounded timeout aborts one request; caller cancellation is not turned into an automatic retry", async () => {
  let calls = 0;
  const request = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      calls++;
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const client = createRequestClient({ request, timeoutMs: 10 });
  const hold = setTimeout(() => {}, 100);
  try {
    await assert.rejects(client("sessions?date=2026-11-02"), {
      code: "request_unavailable",
    });
  } finally {
    clearTimeout(hold);
  }
  assert.equal(calls, 1);
  const controller = new AbortController();
  const aborted = client("track", { token: "dummy" }, controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal(calls, 2);
});

test("known application validation/rate errors remain useful while invalid actions are refused locally", async () => {
  const client = createRequestClient({
    request: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "request_rate_limited",
            message: "Please wait before retrying.",
          },
        }),
        { status: 429 },
      ),
  });
  await assert.rejects(client("submit", {}), {
    code: "request_rate_limited",
    message: "Please wait before retrying.",
  });
  await assert.rejects(
    client("https://other.example/path"),
    /Invalid request action/,
  );
});

test("unchanged review navigation/retries retain one high-entropy submission key; meaningful changes use another", () => {
  let count = 0;
  const key = createSubmissionAttempt(() => `synthetic-key-${++count}`);
  const details = {
    firstName: "Synthetic",
    fatherName: "Father",
    lastName: "Person",
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
    preferredLanguage: "en",
  };
  const selection = {
    date: "2026-11-02",
    professionalId: "doctor:synthetic",
    sourceSessionId: "session:1",
  };
  const original = key(details, selection, "");
  assert.equal(key({ ...details }, { ...selection }, ""), original);
  assert.equal(
    key({ ...details }, { ...selection, capacity: 999 }, ""),
    original,
  );
  assert.notEqual(
    key({ ...details, preferredLanguage: "ar" }, selection, ""),
    original,
  );
  assert.notEqual(
    key(details, { ...selection, sourceSessionId: "session:2" }, ""),
    original,
  );
  assert.equal(count, 3);
});
