import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  requestSelectionUrl,
  validatedPreselection,
} from "../src/request-selection.js";

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
test("cached Full expires to unknown at its exact deadline and missing freshness never blocks a pending request", async () => {
  const { currentAvailability, sessionSelectable } =
    await import("../src/request-preview/RequestForm.jsx");
  const session = {
    availability: "full",
    availabilityExpiresAt: "2027-11-01T10:00:00Z",
  };
  const end = Date.parse(session.availabilityExpiresAt);
  assert.equal(currentAvailability(session, end - 1), "full");
  assert.equal(currentAvailability(session, end), "unknown");
  assert.equal(
    currentAvailability(session, end + 86400000),
    "unknown",
    "return from suspension uses actual deadline",
  );
  assert.equal(currentAvailability({ availability: "full" }, end), "unknown");
  assert.equal(
    sessionSelectable({
      availability: "full",
      availabilityExpiresAt: "2000-01-01T00:00:00Z",
    }),
    true,
  );
});
test("full and unconfigured sessions are distinct and disabled; unknown allows an ordinary pending request without numeric capacity", async () => {
  const { AvailabilityLabel, sessionSelectable } =
    await import("../src/request-preview/RequestForm.jsx");
  for (const [state, selectable, label] of [
    ["full", false, "Session full"],
    ["blocked", false, "Not currently bookable"],
    ["unknown", true, ""],
    [undefined, true, ""],
    ["available", true, ""],
  ]) {
    const session = {
      availability: state,
      availabilityExpiresAt: new Date(Date.now() + 120000).toISOString(),
      capacity: 9,
      remaining: 2,
    };
    assert.equal(sessionSelectable(session), selectable);
    const html = renderToStaticMarkup(
      createElement(AvailabilityLabel, { session, language: "en" }),
    );
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /remaining|capacity|checkbox|\b9\b|\b2\b/);
    const ar = renderToStaticMarkup(
      createElement(AvailabilityLabel, { session, language: "ar" }),
    );
    if (state === "full") assert.match(ar, /ممتلئة/);
  }
});
test("unknown availability uses one shared plain explanation without another acknowledgement", async () => {
  const { UnknownAvailabilityExplanation } =
    await import("../src/request-preview/RequestForm.jsx");
  const html = renderToStaticMarkup(
    createElement(UnknownAvailabilityExplanation, { language: "en" }),
  );
  assert.match(html, /Availability is temporarily unconfirmed/);
  assert.doesNotMatch(html, /checkbox|input|capacity|remaining/);
});

test("Today doctors uses the shared foreground loader rather than an empty-result message", async () => {
  const { Doctors } = await import("../src/components/HomeSections.jsx");
  const html = renderToStaticMarkup(
    createElement(Doctors, {
      result: { status: "loading" },
      onRetry() {},
      onPreview() {},
    }),
  );
  assert.match(html, /Loading today’s doctors/);
  assert.match(html, /lattice/i);
  assert.doesNotMatch(html, /No doctor sessions today|No professionals/);
});
test("Today doctors preserves specialty icons and uses only supplied gender-derived avatar variants", async () => {
  const { Doctors } = await import("../src/components/HomeSections.jsx");
  const sessions = ["female", "male", undefined].map((avatarVariant, n) => ({
    id: `session:${n}`,
    professionalId: `doctor:${n}`,
    date: "2027-11-05",
    doctorName: `Dr. Synthetic ${n}`,
    specialty: "Cardiology",
    startTime: "09:00",
    endTime: "11:00",
    status: "active",
    avatarVariant,
  }));
  const html = renderToStaticMarkup(
    createElement(Doctors, {
      result: {
        status: "success",
        schedule: {
          date: "2027-11-05",
          publicationStatus: "published",
          doctorSessions: sessions,
        },
      },
      onPreview() {},
    }),
  );
  for (const variant of ["female", "male", "neutral"])
    assert.match(html, new RegExp(`data-avatar-variant="${variant}"`));
  assert.doesNotMatch(html, /feature-monogram|Illustrated initials/);
  assert.match(html, /specialty-icon/);
  for (const session of sessions) {
    const url = requestSelectionUrl(session);
    assert.equal(
      validatedPreselection(url.slice(url.indexOf("?")), sessions),
      session,
    );
    assert.equal(validatedPreselection(url.slice(url.indexOf("?")), []), null);
  }
  assert.equal(requestSelectionUrl(), "/request");
});
