// Homepage presentation regression coverage; no database or network access.
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
  date: "2026-11-04",
  doctorName: "Dr. Synthetic Example",
  specialty: "Cardiology",
  startTime: "09:00",
  endTime: "12:00",
  status: "active",
};
const day = {
  date: "2026-11-04",
  timeZone: "Asia/Beirut",
  publicationStatus: "published",
  centerClosed: false,
  centerHours: { startTime: "08:00", endTime: "17:00" },
  doctorSessions: [session],
  specialistSessions: [],
  otherServices: [],
};
const render = async (result) => {
  const { default: HomeSchedule } =
    await import("../src/components/HomeSchedule.jsx");
  return renderToStaticMarkup(
    createElement(HomeSchedule, { result, onRetry() {}, onPreview() {} }),
  );
};
test("homepage schedule separates loading, failure, unpublished, closed and empty states without exposing stale sessions", async () => {
  const cases = [
    [{ status: "loading" }, /Loading today’s schedule/],
    [{ status: "error", schedule: day }, /Try again/],
    [
      {
        status: "success",
        schedule: { ...day, publicationStatus: "unpublished" },
      },
      /not available yet/,
    ],
    [
      { status: "success", schedule: { ...day, centerClosed: true } },
      /closed today/,
    ],
    [
      { status: "success", schedule: { ...day, doctorSessions: [] } },
      /No clinic sessions today/,
    ],
  ];
  for (const [result, pattern] of cases) {
    const html = await render(result);
    assert.match(html, pattern);
    assert.doesNotMatch(html, /Dr\. Synthetic/);
    assert.match(html, /href="\/schedule"/);
  }
});
test("published sessions retain actual hours, cancellation and non-active refusal", async () => {
  const html = await render({
    status: "success",
    schedule: {
      ...day,
      doctorSessions: [
        session,
        {
          ...session,
          id: "cancelled",
          doctorName: "Cancelled Example",
          status: "cancelled",
        },
        {
          ...session,
          id: "paused",
          doctorName: "Unavailable Example",
          status: "paused",
        },
      ],
    },
  });
  assert.match(html, /9:00 AM–12:00 PM/);
  assert.match(html, /Cancelled/);
  assert.match(html, /Unavailable/);
  assert.equal((html.match(/class="home-session-action"/g) || []).length, 1);
  const unpublished = await render({
    status: "success",
    schedule: { ...day, publicationStatus: "unpublished" },
  });
  assert.doesNotMatch(unpublished, /Center hours/);
});
test("homepage preview omits unpublished people and retains only supported service links", async () => {
  const { default: HomeContent } =
    await import("../src/components/HomeContent.jsx");
  const html = renderToStaticMarkup(
    createElement(HomeContent, {
      result: {
        status: "success",
        schedule: { ...day, publicationStatus: "unpublished" },
      },
    }),
  );
  assert.doesNotMatch(html, /Dr\. Synthetic/);
  for (const slug of ["clinic", "laboratory", "audiometry"])
    assert.match(html, new RegExp(`href="/services/${slug}"`));
  assert.match(html, /href="tel:\+96181814554"/);
  assert.match(html, /href="https:\/\/maps\.app\.goo\.gl\/vnkpWvwB95EadX7L8"/);
  assert.match(html, /opens in a new tab/);
  assert.doesNotMatch(
    html,
    /Provisional center story|Synthetic phone placeholder|Cedar Avenue|000 000/,
  );
});

test("homepage corrections retain one directory action and the exact OpenStreetMap marker", async () => {
  const { default: HomeContent } =
    await import("../src/components/HomeContent.jsx");
  for (const result of [
    { status: "error" },
    { status: "success", schedule: day },
  ]) {
    const html = renderToStaticMarkup(createElement(HomeContent, { result }));
    assert.equal((html.match(/href="\/doctors"/g) || []).length, 1);
    assert.match(html, /class="home-button" href="\/doctors"/);
    assert.match(html, /Browse all doctors/);
    assert.match(html, /www\.openstreetmap\.org\/export\/embed\.html\?bbox=/);
    assert.match(html, /marker=33\.8389762%2C35\.5067517/);
    assert.match(html, /href="https:\/\/wa\.me\/96181814554"/);
    assert.match(html, /near Noureddine Bookshop/);
    assert.doesNotMatch(html, /address is fictional|Cedar Avenue|000 000/);
    assert.doesNotMatch(
      html,
      /location-pattern|Location illustration|reveal-pending/,
    );
    assert.match(html, /Choose a clinic session/);
    assert.match(html, /Send your request/);
    assert.match(html, /Reception reviews it/);
  }
});

test("development demo is explicit and synthetic selections are blocked even outside demo mode", async () => {
  const { isHomepageDemo, isHomepageDemoSession } =
    await import("../src/homepage-preview.js");
  assert.equal(isHomepageDemo(true, "/", ""), true);
  assert.equal(isHomepageDemo(true, "", "?preview=live"), false);
  assert.equal(isHomepageDemo(true, "/schedule", ""), false);
  for (const search of ["", "?preview=demo", "?preview=live"])
    assert.equal(isHomepageDemo(false, "/", search), false);
  assert.equal(isHomepageDemoSession({ id: "demo-home-session-1" }), true);
  assert.equal(
    isHomepageDemoSession({ professionalId: "demo-home-professional-1" }),
    true,
  );
  assert.equal(isHomepageDemoSession(session), false);
  assert.equal(isHomepageDemoSession(), false);
});

test("demo preserves the canonical published DTO and all three avatars and specialty icons", async () => {
  const { homepageDemoSchedule: schedule } =
    await import("../src/dev/homepageDemo.js");
  const { default: HomeContent } =
    await import("../src/components/HomeContent.jsx");
  const html = renderToStaticMarkup(
    createElement(HomeContent, { result: { status: "success", schedule } }),
  );
  assert.equal(schedule.doctorSessions.length, 3);
  for (const variant of ["female", "male", "neutral"])
    assert.match(html, new RegExp(`data-avatar-variant="${variant}"`));
  assert.equal((html.match(/class="specialty-icon"/g) || []).length, 3);
  assert.match(html, /Doctors and specialists/);
  assert.doesNotMatch(html, /Looking for a particular doctor/);
  assert.equal((html.match(/id="services"/g) || []).length, 1);
  assert.ok(html.indexOf('id="services"') < html.indexOf('id="doctors"'));
});

test("visit hours use only the published center result and retain contact actions in every state", async () => {
  const { default: HomeContent } =
    await import("../src/components/HomeContent.jsx");
  for (const [result, expected] of [
    [
      { status: "success", schedule: day },
      /Wednesday, November 4, 2026<br\/>8:00 AM–5:00 PM/,
    ],
    [
      { status: "success", schedule: { ...day, centerClosed: true } },
      /closed on this day/,
    ],
    [
      { status: "success", schedule: { ...day, centerHours: null } },
      /opening hours are not listed/,
    ],
    [
      {
        status: "success",
        schedule: { ...day, publicationStatus: "unpublished" },
      },
      /hours are not published/,
    ],
    [{ status: "error", schedule: day }, /hours couldn’t be loaded/],
    [{ status: "loading", schedule: day }, /Loading published center hours/],
  ]) {
    const html = renderToStaticMarkup(createElement(HomeContent, { result }));
    const visit = html.slice(html.indexOf('id="contact"'));
    assert.match(visit, expected);
    assert.match(visit, /href="tel:\+96181814554"/);
    assert.match(visit, /href="https:\/\/wa\.me\/96181814554"/);
    assert.match(visit, /View full schedule/);
    if (
      result.status !== "success" ||
      result.schedule.centerClosed ||
      result.schedule.publicationStatus !== "published"
    )
      assert.doesNotMatch(visit, /8:00 AM–5:00 PM/);
  }
});
