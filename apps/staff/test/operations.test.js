import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanOperationalRecord,
  scheduleForDate,
} from "../src/lib/operations.js";
import { createBroker } from "../electron/transport.js";
import * as operations from "../src/lib/operations.js";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";
import { after } from "node:test";

const sourceRoot = new URL("../src/", import.meta.url).href;
const jsxHook = registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot)) return nextLoad(url, context);
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    if (!url.endsWith(".jsx")) return nextLoad(url, context);
    return {
      format: "module",
      source: transformSync(
        fileURLToPath(url),
        readFileSync(fileURLToPath(url), "utf8"),
        {
          jsx: { runtime: "automatic" },
        },
      ).code,
      shortCircuit: true,
    };
  },
});
after(() => jsxHook.deregister());

test("search motion keeps text inset scoped above shared input styles and honors reduced motion", async () => {
  const css = readFileSync(
    new URL("../src/components/operations.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.operational-page \.staff-field \.operational-search > input\s*\{[^}]*padding-inline-start:\s*2\.8rem/s,
  );
  assert.match(
    css,
    /\.operational-search\[data-filled="true"\] > svg\s*\{[^}]*translate\(-0\.3rem, -50%\) rotate\(-90deg\)/s,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.operational-search > svg\s*\{\s*transition: none;/,
  );
  const { default: Panel } =
    await import("../src/components/OperationsPanel.jsx");
  const html = renderToStaticMarkup(
    createElement(Panel, { api: {}, mode: "professionals" }),
  );
  assert.match(html, /Professionals/);
});
const reviewState = {
  scopes: [
    {
      id: "clinic",
      name: "Synthetic Clinic",
      kind: "clinic",
      active: true,
      access: { edit: true },
    },
    { id: "readonly", active: true, access: { edit: false } },
    { id: "inactive", active: false, access: { edit: true } },
  ],
  professionals: [],
};

test("scope validation rejects missing, unknown, inactive and unassigned scope before a draft save", () => {
  for (const scopeId of ["", "unknown", "readonly", "inactive"])
    assert.equal(
      operations.operationalScopeError("sessions", { scopeId }, reviewState),
      "Choose a valid assigned scope.",
    );
  assert.equal(
    operations.operationalScopeError(
      "sessions",
      { scopeId: "clinic" },
      reviewState,
    ),
    "",
  );
  assert.equal(
    operations.operationalScopeError(
      "exceptions",
      { scopeId: "" },
      reviewState,
    ),
    "Choose a valid assigned scope.",
  );
  assert.equal(
    operations.operationalScopeError(
      "professionals",
      { scopeIds: [] },
      reviewState,
    ),
    "Choose at least one valid assigned clinic.",
  );
  assert.equal(
    operations.operationalScopeError(
      "professionals",
      { scopeIds: ["clinic"] },
      reviewState,
    ),
    "",
  );
});

test("assigned-scope placeholder is disabled, required and retains its visible label", async () => {
  const { default: Fields } =
    await import("../src/components/OperationalSessionFields.jsx");
  const html = renderToStaticMarkup(
    createElement(Fields, {
      state: reviewState,
      value: operations.newSession(""),
      onChange() {},
    }),
  );
  assert.match(html, /<label[^>]*>Clinic\/service<\/label>/);
  assert.match(html, /<select[^>]*required=""/);
  assert.match(
    html,
    /<option value="" disabled="" selected="">Choose assigned scope<\/option>/,
  );
});

test("review verification uses synthetic credentials through real fields, never a bypass or reset", async () => {
  const { verifySyntheticManager } =
    await import("../scripts/operational-review-controls.js");
  const calls = [];
  const control = (name) => ({
    async fill(value) {
      calls.push([name, value]);
    },
    async click() {
      calls.push([name]);
    },
    async waitFor() {},
  });
  const page = {
    getByRole: (_role, { name }) => control(name),
    getByLabel: (name) => control(name),
  };
  const person = {
    id: "synthetic:one",
    username: "review.admin",
    password: "dummy-only",
  };
  await verifySyntheticManager({
    page,
    person,
    nextCode: async () => "012345",
  });
  assert.deepEqual(calls, [
    ["Your current password or passphrase", "dummy-only"],
    ["Verify password"],
    ["Authenticator code", "012345"],
    ["Verify and continue action"],
  ]);
  await assert.rejects(
    verifySyntheticManager({
      page,
      person: { ...person, username: "test.admin" },
    }),
    /synthetic/,
  );
});

test("operational editor sends only allowlisted record fields, never access flags or revisions as authority", () => {
  assert.deepEqual(
    cleanOperationalRecord("scopes", {
      _id: "x",
      id: "clinic",
      name: "Clinic",
      kind: "clinic",
      active: true,
      revision: 5,
      access: { edit: true },
      roles: ["Admin"],
    }),
    { id: "clinic", name: "Clinic", kind: "clinic", active: true },
  );
});
test("dated staff display replaces just the selected scope; cancelled sessions remain visible", () => {
  const a = { id: "a", scopeId: "one", weekday: 1 },
    b = { id: "b", scopeId: "two", weekday: 1, status: "cancelled" };
  const state = {
    sessions: [a, b],
    exceptions: [
      { date: "2026-10-19", scopeId: "one", closed: true, sessions: [] },
    ],
  };
  assert.deepEqual(scheduleForDate(state, "2026-10-19"), [b]);
  assert.deepEqual(scheduleForDate(state, "2026-10-20"), []);
});
test("fixed operational bridge actions retain tokens in main memory and reject late authorized replies after signout", async () => {
  let finish;
  const calls = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/auth/login"))
        return Response.json({ token: "private-test-token" });
      if (url.endsWith("/operations"))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Response.json({ saved: true });
    },
  });
  await broker.signIn({ username: "synthetic", password: "dummy" });
  await broker.saveOperationalRecord({
    type: "scopes",
    record: {},
    expectedRevision: 0,
  });
  const late = broker.operationalState();
  await broker.signOut();
  finish(Response.json({ scopes: ["private"] }));
  await assert.rejects(late, { code: "ACTION_SUPERSEDED" });
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer private-test-token",
  );
  await assert.rejects(broker.operationalState(), { code: "AUTH_REQUIRED" });
});
