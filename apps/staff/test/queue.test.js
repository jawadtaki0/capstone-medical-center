import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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

test("queue broker requires authentication, sends only named routes and discards a delayed private list after sign-out", async () => {
  const calls = [];
  let finish;
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/auth/login"))
        return Response.json({ token: "synthetic-private-token" });
      if (url.endsWith("/queue/list"))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Response.json({ sessions: [] });
    },
  });
  for (const name of [
    "queueSessions",
    "queueList",
    "checkInPatient",
    "queueAdmit",
  ])
    await assert.rejects(broker[name]({}), { code: "AUTH_REQUIRED" });
  await broker.signIn({ username: "synthetic", password: "Synthetic only" });
  await broker.queueSessions({ date: "2026-11-02" });
  await broker.checkInPatient({ bookingId: "synthetic" });
  await broker.queueAdmit({ kind: "walk_in" });
  const late = broker.queueList({ date: "2026-11-02" });
  await broker.signOut();
  finish(Response.json({ bookings: [{ patientName: "Private synthetic" }] }));
  await assert.rejects(late);
  assert.deepEqual(
    calls
      .filter((c) => c.url.includes("/queue/"))
      .map((c) => c.url.split("/queue/")[1]),
    ["sessions", "checkIn", "admit", "list"],
  );
  assert.ok(
    calls
      .filter((c) => c.url.includes("/queue/"))
      .every(
        (c) =>
          c.options.headers.Authorization === "Bearer synthetic-private-token",
      ),
  );
});

test("preload and main allowlist accept check-in fields and refuse arbitrary URLs, arrival times and renderer authority", () => {
  const main = readFileSync(
    new URL("../electron/main.js", import.meta.url),
    "utf8",
  );
  const preload = readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  const validate = runInNewContext(
    `${main.slice(main.indexOf("function validatePayload("), main.indexOf("function initialize("))}; validatePayload`,
  );
  const input = {
    date: "2026-11-02",
    scopeId: "clinic:synthetic",
    sourceSessionId: "session:synthetic",
    sessionVersion: "synthetic",
    bookingId: "synthetic",
    expectedRevision: 0,
    idempotencyKey: "synthetic",
  };
  validate("checkInPatient", input);
  const admission = {
    date: input.date,
    scopeId: input.scopeId,
    sourceSessionId: input.sourceSessionId,
    sessionVersion: input.sessionVersion,
    kind: "walk_in",
    patientId: "synthetic",
    patientRevision: 1,
    idempotencyKey: "synthetic",
  };
  validate("queueAdmit", admission);
  for (const field of [
    "url",
    "extraAdmission",
    "source",
    "queueNumber",
    "roles",
  ])
    assert.throws(
      () => validate("queueAdmit", { ...admission, [field]: "untrusted" }),
      /Unexpected action fields/,
    );
  validate("queueTransition", {
    ...input,
    action: "restoreArrival",
    reason: "Missed earlier arrival",
    arrivedBeforeEnd: true,
  });
  validate("queueTransition", {
    ...input,
    action: "outOfOrder",
    reason: "Synthetic instruction",
    professionalInstructed: true,
  });
  for (const field of [
    "url",
    "checkedInAt",
    "queueNumber",
    "roles",
    "position",
    "before",
  ])
    assert.throws(
      () =>
        validate("queueTransition", {
          ...input,
          action: "correct",
          reason: "Synthetic correction",
          [field]: "untrusted",
        }),
      /Unexpected action fields/,
    );
  for (const field of ["url", "checkedInAt", "queueNumber", "roles"])
    assert.throws(
      () => validate("checkInPatient", { ...input, [field]: "untrusted" }),
      /Unexpected action fields/,
    );
  for (const name of [
    "queueSessions",
    "queueList",
    "checkInPatient",
    "queueTransition",
  ])
    assert.ok(preload.includes(`"${name}"`));
});

test("queue screen retains the accepted sections, truthful unloaded states and disabled later actions", async () => {
  const { default: Panel } = await import("../src/components/QueuePanel.jsx");
  const html = renderToStaticMarkup(createElement(Panel, { api: {} }));
  for (const label of [
    "Patient queue",
    "Session date (Asia/Beirut)",
    "Professional",
    "Session",
    "Booked—not arrived",
    "Booked patients have not been loaded",
    "Waiting",
    "Active patient",
    "Temporarily absent",
    "Session history",
    "Completed",
    "Left",
    "No-show",
    "Cancelled",
    "Waiting list has not been loaded",
  ])
    assert.ok(html.includes(label), label);
  assert.equal(html.includes("Waiting · 0"), false);
  for (const text of ["Accept walk-in", "Admit extra today", "Call next"])
    assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>[^<]*${text}`));
  assert.equal(html.includes("Rami Example"), false);
  for (const label of [
    "Queue patient",
    "Queue action",
    "Apply queue action",
    "Correct status",
    "Select a booked patient",
    "Confirm check-in",
    "Check in patient",
  ])
    assert.equal(html.includes(label), false);
});
