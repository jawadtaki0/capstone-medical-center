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

test("patient bridge uses fixed authenticated actions, clears authority and rejects delayed private reads", async () => {
  const calls = [];
  let finish;
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/auth/login"))
        return Response.json({
          token: "synthetic-private-token",
          user: { username: "synthetic" },
        });
      if (url.endsWith("/patients/read"))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Response.json({ patients: [] });
    },
  });
  await assert.rejects(broker.searchPatients({ firstName: "Synthetic" }), {
    code: "AUTH_REQUIRED",
  });
  await broker.signIn({ username: "synthetic", password: "Synthetic only" });
  for (const name of [
    "searchPatients",
    "checkPatientDuplicates",
    "createPatient",
    "updatePatient",
  ])
    await broker[name]({ record: { firstName: "Synthetic" } });
  assert.ok(
    calls
      .filter((c) => c.url.includes("/patients/"))
      .every(
        (c) =>
          c.options.headers.Authorization === "Bearer synthetic-private-token",
      ),
  );
  const late = broker.readPatient({ patientId: "synthetic" });
  await broker.signOut();
  finish(Response.json({ patient: { firstName: "Private response" } }));
  await assert.rejects(late);
  assert.equal(
    JSON.stringify(broker).includes("synthetic-private-token"),
    false,
  );
});
test("registry and edit dialog keep separate names, required maternal helper, accessible review and no portal controls", async () => {
  const { default: Registry } =
      await import("../src/components/PatientRegistry.jsx"),
    { default: Editor } = await import("../src/components/PatientEditor.jsx");
  const html = renderToStaticMarkup(createElement(Registry, { api: {} }));
  assert.ok(html.includes("Search patients"));
  assert.ok(html.includes("Father’s name"));
  assert.equal(html.includes("Register new patient"), false);
  const editor = renderToStaticMarkup(
    createElement(Editor, { api: {}, patient: {}, onClose() {} }),
  );
  for (const value of [
    "Mother’s maiden name",
    "Check duplicates",
    'aria-modal="true"',
    "No patient portal account",
  ])
    assert.ok(editor.includes(value));
  assert.equal(editor.includes("Enter your mother’s first name only."), false);
  assert.ok(editor.includes("Phone country"));
  assert.ok(editor.includes("patient-contact-grid"));
  assert.equal(editor.includes("Delete patient"), false);
});
test("all four current roles see Patients without operational grants; unknown roles do not", async () => {
  const { default: Workspace } =
    await import("../src/components/Workspace.jsx");
  for (const roles of [
    ["Admin"],
    ["Clinic Admin"],
    ["Lab Admin"],
    ["Receptionist"],
    ["Receptionist", "Lab Admin"],
    ["Unknown"],
  ]) {
    const html = renderToStaticMarkup(
      createElement(Workspace, {
        api: {},
        user: { username: "synthetic", roles },
        workspace: { roles, permissions: [] },
        timing: {},
      }),
    );
    assert.equal(
      html.includes(">Patients</button>"),
      !roles.includes("Unknown"),
    );
  }
});

test("shared country selector loads a saved international phone without duplicating its prefix", async () => {
  const { default: PhoneInput } =
    await import("../src/components/PhoneInput.jsx");
  const html = renderToStaticMarkup(
    createElement(PhoneInput, {
      label: "Phone number",
      defaultValue: "+12025550123",
    }),
  );
  assert.ok(html.includes('value="US" selected=""'));
  const hidden = html.match(/<input[^>]+name="phone"[^>]*>/)[0];
  assert.match(hidden, /type="hidden"/);
  assert.match(hidden, /value="\+12025550123"/);
  const input = html.match(/<input[^>]+name="phoneNational"[^>]*>/)[0];
  assert.equal(input.includes('value="+1'), false);
});
