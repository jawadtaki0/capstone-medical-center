import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = new URL("../src/", import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (
      !url.startsWith(root) &&
      !url.startsWith(new URL("../../../shared/ui/", import.meta.url).href)
    )
      return next(url, context);
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

test("automatic request confirmation binds the original review without inventing a patient ID", async () => {
  const { requestBookingInput } =
    await import("../src/components/WebsiteRequests.jsx");
  const review = {
    key: "stable-key",
    patientCreation: { mode: "create_if_unmatched" },
    patient: { id: null },
    session: { version: "v1" },
  };
  const request = {
    selection: { date: "2026-11-02", sourceSessionId: "session" },
    scopeId: "clinic",
  };
  assert.deepEqual(requestBookingInput(review, request), {
    patientMode: "create_if_unmatched",
    booking: {
      date: "2026-11-02",
      sourceSessionId: "session",
      scopeId: "clinic",
      sessionVersion: "v1",
      idempotencyKey: "stable-key",
    },
  });
  assert.deepEqual(
    requestBookingInput(review, request),
    requestBookingInput(review, request),
  );
  review.patientCreation = undefined;
  review.patient = { id: "patient", revision: 4 };
  const linked = requestBookingInput(review, request);
  assert.equal(linked.booking.patientId, "patient");
  assert.equal(linked.booking.patientRevision, 4);
  assert.equal(Object.hasOwn(linked, "patientMode"), false);
});

test("straight matching ignores name case/spacing but preserves real discrepancy acknowledgement", async () => {
  const { requestPatientDiscrepancies } =
    await import("../src/components/WebsiteRequests.jsx");
  const p = {
    firstName: "Nadia",
    fatherName: "Ali",
    lastName: "Example",
    motherFirstName: "Hana",
    dateOfBirth: "2000-01-01",
    gender: "female",
    phone: "+96171123456",
  };
  assert.deepEqual(
    requestPatientDiscrepancies({ ...p, firstName: " NADIA  " }, p),
    [],
  );
  assert.deepEqual(
    requestPatientDiscrepancies(
      { ...p, phone: "+96171123457", dateOfBirth: "2001-01-01" },
      p,
    ),
    ["dateOfBirth", "phone"],
  );
});

test("request navigation separates unresolved messages from history and accepts dashboard entry tabs", async () => {
  const { default: Requests } =
    await import("../src/components/WebsiteRequests.jsx");
  const html = renderToStaticMarkup(
    createElement(Requests, { api: {}, initialView: "messages" }),
  );
  for (const label of ["Requests", "Messages to send", "History"])
    assert.ok(html.includes(label));
  assert.doesNotMatch(html, /Notification worklist|>Inbox</);
});
