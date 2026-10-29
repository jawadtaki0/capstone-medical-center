import { test } from "node:test";
import assert from "node:assert/strict";
import { whatsappUrl } from "../electron/whatsapp.js";
import { createBroker } from "../electron/transport.js";

test("only explicit isolated hosted review extends Refresh requests; other authority/action deadlines stay unchanged", async () => {
  for (const options of [
    { url: "http://127.0.0.1:4100", demoMode: true },
    { url: "https://127.0.0.1:4101", demoMode: true },
    { url: "https://127.0.0.1:4101", demoMode: false },
  ])
    assert.throws(
      () => createBroker({ ...options, reviewColdStart: true }),
      /isolated review/,
    );
  const original = AbortSignal.timeout;
  const deadlines = [];
  AbortSignal.timeout = (ms) => {
    deadlines.push(ms);
    return new AbortController().signal;
  };
  try {
    for (const reviewColdStart of [false, true]) {
      const broker = createBroker({
        url: "http://127.0.0.1:4101",
        demoMode: true,
        reviewColdStart,
        request: async (url) =>
          new Response(
            JSON.stringify(
              url.endsWith("/auth/login") ? { token: "t".repeat(43) } : {},
            ),
          ),
      });
      await broker.signIn({ username: "synthetic", password: "dummy only" });
      await broker.websiteRequests({ action: "refresh" });
      await broker.websiteRequests({ action: "list" });
    }
    assert.deepEqual(deadlines, [5000, 20000, 5000, 5000, 90000, 5000]);
  } finally {
    AbortSignal.timeout = original;
  }
});

test("review refresh unavailability preserves the current session and caller data; real expiry still clears authorization", async () => {
  let state = "network",
    seenAuthorization;
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    reviewColdStart: true,
    request: async (url, options) => {
      if (url.endsWith("/auth/login"))
        return new Response(JSON.stringify({ token: "t".repeat(43) }));
      if (url.endsWith("/website-requests/refresh")) {
        if (state === "network")
          throw Error("synthetic-private-provider-error");
        if (state === "busy")
          return new Response(
            JSON.stringify({
              error: {
                code: "temporary",
                message: "synthetic-private-provider-error",
              },
            }),
            { status: 503 },
          );
        return new Response(
          JSON.stringify({
            error: { code: "session_expired", message: "Sign in again." },
          }),
          { status: 401 },
        );
      }
      seenAuthorization = options.headers.Authorization;
      return new Response(JSON.stringify({ requests: [] }));
    },
  });
  await broker.signIn({ username: "synthetic", password: "dummy only" });
  const payload = { action: "refresh" };
  for (const failure of ["network", "busy"]) {
    state = failure;
    await assert.rejects(broker.websiteRequests(payload), (error) => {
      assert.equal(error.code, "REQUEST_SYNC_UNAVAILABLE");
      assert.match(error.message, /waking/);
      assert.match(error.message, /not rolled back/);
      assert.equal(error.message.includes("synthetic-private"), false);
      return true;
    });
    assert.deepEqual(payload, { action: "refresh" });
    await broker.websiteRequests({ action: "list" });
    assert.equal(seenAuthorization, `Bearer ${"t".repeat(43)}`);
  }
  state = "expired";
  await assert.rejects(broker.websiteRequests(payload), {
    code: "session_expired",
  });
  await assert.rejects(broker.sessionStatus(), { code: "AUTH_REQUIRED" });
});

test("a delayed hosted review refresh cannot restore authorization after sign-out", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    reviewColdStart: true,
    request: async (url) =>
      url.endsWith("/website-requests/refresh")
        ? pending
        : new Response(
            JSON.stringify(
              url.endsWith("/auth/login") ? { token: "t".repeat(43) } : {},
            ),
          ),
  });
  await broker.signIn({ username: "synthetic", password: "dummy only" });
  const refresh = broker.websiteRequests({ action: "refresh" });
  await broker.signOut();
  finish(new Response(JSON.stringify({ refreshed: true })));
  await assert.rejects(refresh, { code: "ACTION_SUPERSEDED" });
  await assert.rejects(broker.sessionStatus(), { code: "AUTH_REQUIRED" });
});
test("manual WhatsApp URL fixes host, canonical digits and Arabic text encoding", () => {
  const u = new URL(
    whatsappUrl("+96171123456", "*مؤكد*\nName: Synthetic & ? #"),
  );
  assert.equal(u.protocol, "https:");
  assert.equal(u.hostname, "wa.me");
  assert.equal(u.pathname, "/96171123456");
  assert.equal(u.searchParams.get("text"), "*مؤكد*\nName: Synthetic & ? #");
  for (const phone of [
    "https://evil.test/",
    "+961 71 123 456",
    "../secret",
    "+0000",
  ])
    assert.throws(() => whatsappUrl(phone, "message"));
});
test("renderer supplies notice ID only; main builds authorized content and does not return link/message", async () => {
  const calls = [],
    opened = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    openWhatsApp: async (phone, message) => opened.push({ phone, message }),
    request: async (url, options) => {
      const b = JSON.parse(options.body ?? "{}");
      calls.push(b);
      return new Response(
        JSON.stringify(
          url.endsWith("/auth/login")
            ? { token: "a".repeat(43) }
            : b.action === "prepare"
              ? {
                  phone: "+96171123456",
                  message: "مؤكد private-link-synthetic",
                  version: 1,
                }
              : {},
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  await broker.signIn({ username: "synthetic", password: "synthetic only" });
  await assert.rejects(
    broker.openRequestWhatsApp({
      noticeId: "notice",
      url: "https://evil.test",
    }),
  );
  assert.throws(() =>
    broker.websiteRequests({
      action: "notification",
      noticeAction: "prepare",
      noticeId: "notice",
    }),
  );
  const result = await broker.openRequestWhatsApp({ noticeId: "notice" });
  assert.equal(opened.length, 1);
  assert.equal(result.opened, true);
  assert.equal(JSON.stringify(result).includes("private-link"), false);
  assert.equal(calls.at(-1).noticeId, "notice");
  assert.equal(calls.at(-1).action, "opened");
  assert.equal(calls.at(-1).key, calls.find((c) => c.action === "opening").key);
});
test("external opening failure records safe outcome but never marks sent", async () => {
  const actions = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    openWhatsApp: async () => {
      throw Error("Synthetic opening failure");
    },
    request: async (url, options) => {
      const b = JSON.parse(options.body ?? "{}");
      actions.push(b.action);
      return new Response(
        JSON.stringify(
          url.endsWith("/auth/login")
            ? { token: "a".repeat(43) }
            : b.action === "prepare"
              ? { phone: "+96171123456", message: "Synthetic" }
              : {},
        ),
        { status: 200 },
      );
    },
  });
  await broker.signIn({ username: "synthetic", password: "synthetic" });
  await assert.rejects(
    broker.openRequestWhatsApp({ noticeId: "notice" }),
    /Nothing was marked sent/,
  );
  assert.ok(actions.includes("open_failed"));
  assert.equal(actions.includes("sent"), false);
});
