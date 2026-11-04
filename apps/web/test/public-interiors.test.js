// Public interior presentation regressions; no database or network access.
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

const session = {
  id: "session-example",
  professionalId: "professional-example",
  doctorName: "Dr. Example",
  specialty: "Cardiology",
  date: "2027-01-04",
  startTime: "09:00",
  endTime: "12:00",
  status: "active",
};
test("public rows retain exact session selection and never offer cancelled/unavailable actions", async () => {
  const { default: Row } =
    await import("../src/components/PublicSessionRow.jsx");
  const active = renderToStaticMarkup(
    createElement(Row, { session, label: "Clinic session" }),
  );
  assert.match(active, /Request session/);
  assert.match(
    active,
    /professional=professional-example&amp;date=2027-01-04&amp;session=session-example&amp;start=09%3A00&amp;end=12%3A00/,
  );
  for (const status of ["cancelled", "paused"]) {
    const html = renderToStaticMarkup(
      createElement(Row, {
        session: { ...session, status },
        label: "Clinic session",
      }),
    );
    assert.doesNotMatch(html, /href=|<button/);
    assert.match(html, status === "cancelled" ? /Cancelled/ : /Unavailable/);
  }
});
test("tracking status is the main heading, with accurate status-specific copy and real dated events in both languages", async () => {
  const { default: Tracking, STATUS_EXPLANATIONS } =
    await import("../src/request-preview/TrackingView.jsx");
  for (const language of ["en", "ar"])
    for (const status of ["awaiting", "confirmed", "rejected", "cancelled"]) {
      const data = {
        reference: "WR-EXAMPLE",
        professional: "Dr. Example",
        date: "2027-01-04",
        startTime: "09:00",
        endTime: "12:00",
        status,
        language,
        events: [{ at: "2027-01-01T12:00:00Z", status }],
        trackingToken: "not-for-page-output",
        patient: { name: "NotForDisplay" },
      };
      const html = renderToStaticMarkup(
        createElement(Tracking, {
          data,
          onLanguage() {},
          requestHref: "/request",
        }),
      );
      assert.match(html, /<h1[^>]*tracking-status-heading/);
      assert.ok(html.includes(STATUS_EXPLANATIONS[status][language]));
      assert.match(html, /request-timeline/);
      assert.match(html, /dateTime="2027-01-01T12:00:00Z"/);
      assert.doesNotMatch(html, /not-for-page-output|NotForDisplay/);
      if (["rejected", "cancelled"].includes(status))
        assert.doesNotMatch(
          html,
          /Staff reviews your request|يراجع الموظف طلبك/,
        );
    }
});
test("missing tracking links retain safe recovery and the actual request destination", async () => {
  const { default: Tracking } =
    await import("../src/request-preview/TrackingView.jsx");
  const html = renderToStaticMarkup(
    createElement(Tracking, { onLanguage() {}, requestHref: "/request" }),
  );
  assert.match(html, /Tracking link unavailable/);
  assert.match(html, /reference alone does not provide access/);
  assert.match(html, /href="\/request"/);
});
