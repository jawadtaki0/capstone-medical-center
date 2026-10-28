import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBroker } from "../electron/transport.js";
const root = new URL("../src/", import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (!url.startsWith(root)) return next(url, context);
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    if (!url.endsWith(".jsx")) return next(url, context);
    return {
      format: "module",
      source: transformSync(
        fileURLToPath(url),
        readFileSync(fileURLToPath(url), "utf8"),
        { jsx: { runtime: "automatic" } },
      ).code,
      shortCircuit: true,
    };
  },
});
after(() => hook.deregister());

test("booking bridge uses named authenticated actions and discards delayed data after sign-out", async () => {
  const calls = [];
  let finish;
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/auth/login"))
        return Response.json({ token: "synthetic-private-token" });
      if (url.endsWith("/bookings/review"))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Response.json({ sessions: [], bookings: [] });
    },
  });
  await assert.rejects(broker.bookingSessions({ date: "2026-11-02" }), {
    code: "AUTH_REQUIRED",
  });
  await broker.signIn({ username: "synthetic", password: "Synthetic only" });
  for (const method of [
    "bookingSessions",
    "confirmBooking",
    "listBookings",
    "cancelBooking",
    "affectedBookings",
  ])
    await broker[method]({ date: "2026-11-02" });
  assert.equal(calls.filter((c) => c.url.includes("/bookings/")).length, 5);
  assert.ok(
    calls
      .filter((c) => c.url.includes("/bookings/"))
      .every(
        (c) =>
          c.options.headers.Authorization === "Bearer synthetic-private-token",
      ),
  );
  const late = broker.reviewBooking({ patientId: "synthetic" });
  await broker.signOut();
  finish(Response.json({ patient: { firstName: "Private" } }));
  await assert.rejects(late);
  const main = readFileSync(
      new URL("../electron/main.js", import.meta.url),
      "utf8",
    ),
    preload = readFileSync(
      new URL("../electron/preload.cjs", import.meta.url),
      "utf8",
    );
  for (const method of [
    "bookingSessions",
    "reviewBooking",
    "confirmBooking",
    "listBookings",
    "cancelBooking",
    "affectedBookings",
  ]) {
    assert.ok(main.includes(`${method}:`));
    assert.ok(preload.includes(`"${method}"`));
  }
});
test("booking screens describe a full window, retain existing patient search and expose no intake/queue/billing controls", async () => {
  const { default: Panel } = await import("../src/components/BookingPanel.jsx"),
    { default: Records } = await import("../src/components/BookingRecords.jsx");
  const html = renderToStaticMarkup(createElement(Panel, { api: {} }));
  for (const text of [
    "Search patients",
    "Patient number",
    "Session date (Asia/Beirut)",
    "not an exact appointment time",
    "Actual check-in determines consultation order",
    "Load sessions",
  ])
    assert.ok(html.includes(text), text);
  for (const text of [
    "Register new patient",
    "Check in",
    "Pay",
    "Accept extra",
  ])
    assert.equal(html.includes(text), false);
  const records = renderToStaticMarkup(
    createElement(Records, { api: {}, affected: true }),
  );
  assert.ok(records.includes("Active bookings"));
  assert.ok(records.includes("No booking is moved or cancelled automatically"));
});
