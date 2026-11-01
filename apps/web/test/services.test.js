import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { services } from "../src/data/homeContent.js";

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

test("Laboratory navigation is a keyboard-native information link on desktop and mobile", async () => {
  const { default: Header } = await import("../src/components/Header.jsx");
  const previousWindow = globalThis.window;
  try {
    for (const mobile of [false, true]) {
      globalThis.window = { matchMedia: () => ({ matches: mobile }) };
      const html = renderToStaticMarkup(
        createElement(Header, {
          homePage: false,
          onPreview() {
            throw Error("Laboratory must not use a prototype action");
          },
        }),
      );
      assert.match(
        html,
        /<a[^>]*href="\/services\/laboratory"[^>]*>\s*<span>Laboratory<\/span>\s*<\/a>/,
      );
      assert.doesNotMatch(
        html,
        /<button[^>]*>\s*<span>Laboratory<\/span>\s*<\/button>/,
      );
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

const day = {
  date: "2027-11-01",
  timeZone: "Asia/Beirut",
  publicationStatus: "published",
  centerClosed: false,
  centerHours: { startTime: "08:00", endTime: "17:00" },
  doctorSessions: [
    {
      id: "session:doctor",
      doctorName: "Dr. Synthetic",
      startTime: "09:00",
      endTime: "11:00",
      appointmentRequired: true,
    },
  ],
  specialistSessions: [],
  otherServices: [
    {
      id: "laboratory",
      name: "Laboratory",
      startTime: "08:00",
      endTime: "14:30",
    },
    {
      id: "audiometry",
      name: "Audiometry",
      startTime: "09:00",
      endTime: "13:00",
    },
  ],
};
test("Home has only the approved three service categories and meaningful information links", async () => {
  const { Services } = await import("../src/components/HomeSections.jsx");
  const html = renderToStaticMarkup(createElement(Services));
  assert.deepEqual(
    services.map((s) => s.title),
    ["Clinic consultations", "Laboratory", "Audiometry"],
  );
  for (const service of services)
    assert.ok(html.includes(`href="/services/${service.slug}"`));
  assert.doesNotMatch(html, /Family care|<button/);
});
test("service information uses only its published hours and never offers laboratory/audiometry booking", async () => {
  const { ServiceInformation } = await import("../src/pages/ServicePage.jsx");
  const render = (slug, result = { status: "success", schedule: day }) =>
    renderToStaticMarkup(
      createElement(ServiceInformation, {
        service: services.find((s) => s.slug === slug),
        result,
        onRetry() {},
      }),
    );
  const laboratory = render("laboratory"),
    audiometry = render("audiometry"),
    clinic = render("clinic");
  assert.match(laboratory, /8:00 AM–2:30 PM/);
  assert.doesNotMatch(
    laboratory,
    /9:00 AM–1:00 PM|href="\/request|Dr\. Synthetic/,
  );
  assert.match(audiometry, /9:00 AM–1:00 PM/);
  assert.doesNotMatch(audiometry, /8:00 AM–2:30 PM|href="\/request/);
  assert.match(clinic, /Dr\. Synthetic|Appointment required/);
  assert.match(clinic, /href="\/request"/);
  assert.doesNotMatch(
    laboratory + audiometry,
    /price|preparation|blood test|hearing loss/i,
  );
});
test("service loading/error/unpublished/closed and missing-hour states remain distinct", async () => {
  const { ServiceInformation } = await import("../src/pages/ServicePage.jsx");
  const service = services.find((s) => s.slug === "laboratory");
  const render = (result) =>
    renderToStaticMarkup(
      createElement(ServiceInformation, { service, result, onRetry() {} }),
    );
  assert.match(
    render({ status: "loading" }),
    /Loading published service hours|lattice/i,
  );
  assert.doesNotMatch(
    render({ status: "loading" }),
    /No published Laboratory hours/,
  );
  assert.match(render({ status: "error" }), /couldn’t load|Try again/);
  assert.match(
    render({
      status: "success",
      schedule: { ...day, publicationStatus: "unpublished" },
    }),
    /not available for this date yet/,
  );
  assert.match(
    render({ status: "success", schedule: { ...day, centerClosed: true } }),
    /center is closed/,
  );
  assert.match(
    render({ status: "success", schedule: { ...day, otherServices: [] } }),
    /No published Laboratory hours/,
  );
});
