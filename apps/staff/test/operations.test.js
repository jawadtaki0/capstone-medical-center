import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanOperationalRecord,
  scheduleForDate,
  oneDateReplacement,
  limitOnlyEdit,
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
import {
  ROLES,
  requiresMfa,
  assertCompatibleRolePolicy,
} from "../../../shared/staff-roles.mjs";

test("review package requires a matching four-role API and explicit administrative MFA classification", () => {
  assert.deepEqual(ROLES, [
    "Admin",
    "Clinic Admin",
    "Lab Admin",
    "Receptionist",
  ]);
  assert.doesNotThrow(() => assertCompatibleRolePolicy("four-roles-v1"));
  for (const policy of [undefined, null, "six-roles", ""])
    assert.throws(() => assertCompatibleRolePolicy(policy), {
      code: "role_policy_mismatch",
    });
  assert.equal(requiresMfa(["Receptionist"]), false);
  assert.equal(requiresMfa(["Receptionist", "Clinic Admin"]), true);
});

const sourceRoot = new URL("../src/", import.meta.url).href;
const jsxHook = registerHooks({
  load(url, context, nextLoad) {
    if (
      !url.startsWith(sourceRoot) &&
      !url.startsWith(new URL("../../../shared/ui/", import.meta.url).href)
    )
      return nextLoad(url, context);
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

test("one-date professional change preserves peers, IDs and private limits and reuses existing date revision", () => {
  const session = (id, professionalId, capacity) => ({
    id,
    scopeId: "clinic",
    professionalId,
    weekday: 1,
    startTime: "09:00",
    endTime: "11:00",
    capacity,
    status: "active",
    appointmentRequired: false,
  });
  const state = {
    scopes: [
      { id: "clinic", kind: "clinic", active: true, access: { edit: true } },
    ],
    professionals: [
      { id: "one", scopeIds: ["clinic"], canEdit: true },
      { id: "two", scopeIds: ["clinic"], canEdit: true },
    ],
    sessions: [session("s1", "one", 3), session("s2", "two", null)],
    exceptions: [],
  };
  const away = oneDateReplacement(
    state,
    "2026-11-02",
    "professional|one",
    true,
    [],
  );
  assert.equal(away.record.closed, false);
  assert.deepEqual(away.record.sessions, [state.sessions[1]]);
  assert.deepEqual(
    state.sessions.map((s) => s.capacity),
    [3, null],
  );
  const closed = oneDateReplacement(
    state,
    "2026-11-02",
    "scope|clinic",
    true,
    [],
  );
  assert.equal(closed.record.closed, true);
  assert.equal(closed.record.sessions.length, 0);
  state.exceptions = [{ ...away.record, id: "existing", revision: 7 }];
  const restored = oneDateReplacement(
    state,
    "2026-11-02",
    "professional|one",
    false,
    [{ ...state.sessions[0], endTime: "12:00" }],
  );
  assert.equal(restored.record.id, "existing");
  assert.equal(restored.prior.revision, 7);
  assert.deepEqual(
    restored.record.sessions.find((s) => s.id === "s2"),
    state.sessions[1],
  );
  state.scopes[0].access.edit = false;
  assert.throws(
    () => oneDateReplacement(state, "2026-11-02", "scope|clinic", true, []),
    /authorized/,
  );
});
test("limit-only editing uses explicit private save without classifying public edits as private", async () => {
  const before = {
    ...operations.newSession("clinic"),
    revision: 2,
    professionalId: "one",
    capacity: null,
    startTime: "09:00",
    endTime: "11:00",
  };
  assert.equal(
    limitOnlyEdit("sessions", before, { ...before, capacity: 3 }),
    true,
  );
  assert.equal(
    limitOnlyEdit("sessions", before, {
      ...before,
      capacity: 3,
      endTime: "12:00",
    }),
    false,
  );
  assert.equal(
    limitOnlyEdit("sessions", { ...before, revision: 0 }, before),
    false,
  );
  const { default: OneDateEditor } =
    await import("../src/components/OneDateEditor.jsx");
  const html = renderToStaticMarkup(
    createElement(OneDateEditor, {
      initial: { date: "2026-11-02", scopeId: "", closed: true, sessions: [] },
      state: { scopes: [], professionals: [], sessions: [], exceptions: [] },
    }),
  );
  assert.match(html, /Change one date/);
  assert.match(
    html,
    /Only this date changes\. The weekly schedule stays unchanged\./,
  );
});

test("patient limit is a natural optional manual input independent of duration; Gender remains authoritative", async () => {
  const { default: Fields } =
    await import("../src/components/OperationalSessionFields.jsx");
  const state = {
    scopes: [
      { id: "synthetic", kind: "clinic", active: true, access: { edit: true } },
    ],
    professionals: [
      {
        id: "doctor:synthetic",
        specialty: "Dentistry",
        scopeIds: ["synthetic"],
      },
    ],
  };
  const render = (endTime) =>
    renderToStaticMarkup(
      createElement(Fields, {
        state,
        onChange() {},
        value: {
          scopeId: "synthetic",
          professionalId: "doctor:synthetic",
          weekday: 1,
          startTime: "09:00",
          endTime,
          capacity: 4,
          status: "active",
          appointmentRequired: true,
        },
      }),
    );
  const html = render("12:00");
  assert.match(html, /Patient limit/);
  assert.match(html, /value="4"/);
  assert.doesNotMatch(html, /readonly=""/i);
  assert.match(render("11:10"), /Blank means not configured/);
  assert.doesNotMatch(render("11:10"), /Apply calculated capacity/);
  const source = readFileSync(
    new URL("../src/components/OperationalEditor.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /select\("gender", "Gender"/);
  assert.doesNotMatch(source, /Confirmed avatar selection/);
});

test("delivery feedback distinguishes local pending/failure/acceptance without claiming premature visibility", async () => {
  const { default: Delivery } =
    await import("../src/components/PublicationDelivery.jsx");
  const render = (state) =>
    renderToStaticMarkup(
      createElement(Delivery, {
        configured: true,
        deliveries: [
          {
            id: "publication:1",
            sequence: 1,
            effectiveFrom: "2099-01-01",
            attempts: 1,
            canRetry: true,
            ...state,
          },
        ],
        onRetry() {},
        onRefresh() {},
      }),
    );
  assert.match(render({ state: "pending" }), /Updating — awaiting delivery/);
  assert.doesNotMatch(render({ state: "pending" }), /Website updated/);
  assert.match(
    render({ state: "pending" }),
    /<summary>Technical details<\/summary>/,
  );
  assert.match(
    render({ state: "failed", lastError: "receiver_unavailable" }),
    /Receiver unavailable/,
  );
  assert.match(
    render({ state: "accepted", acceptedSequence: 1 }),
    /Website update accepted/,
  );
  assert.match(
    render({ state: "accepted", acceptedSequence: 1 }),
    /effective date/,
  );
  const disabled = renderToStaticMarkup(
    createElement(Delivery, { configured: false, deliveries: [] }),
  );
  assert.match(disabled, /not configured/);
  assert.doesNotMatch(disabled, /Retry delivery/);
});

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
      { scopeId: "clinic", capacity: null },
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
    "",
  );
  assert.equal(
    operations.operationalScopeError(
      "professionals",
      { scopeIds: ["clinic"] },
      reviewState,
    ),
    "",
  );
  for (const scopes of [
    [],
    [
      ...reviewState.scopes,
      { id: "second", kind: "clinic", active: true, access: { edit: true } },
    ],
  ])
    assert.equal(
      operations.operationalScopeError(
        "professionals",
        {},
        { ...reviewState, scopes },
      ),
      "Exactly one active clinic must be configured before editing a professional.",
    );
  assert.equal(
    operations.operationalScopeError(
      "professionals",
      {},
      {
        ...reviewState,
        scopes: [{ ...reviewState.scopes[0], access: { edit: false } }],
      },
    ),
    "Your current account cannot edit this clinic's professionals.",
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
