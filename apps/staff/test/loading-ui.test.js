import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { transformSync } from "rolldown/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const roots = [
  new URL("../src/", import.meta.url).href,
  new URL("../../../shared/ui/", import.meta.url).href,
];
const hook = registerHooks({
  load(url, context, next) {
    if (!roots.some((root) => url.startsWith(root))) return next(url, context);
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

test("foreground loader has a useful accessible label without elapsed timer or Thinking wording", async () => {
  const { default: Loading } =
    await import("../../../shared/ui/LoadingStatus.jsx");
  const html = renderToStaticMarkup(
    createElement(Loading, { label: "Saving changes…", wakeHint: true }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Saving changes/);
  assert.doesNotMatch(html, /lattice-loader__timer|0\.0s|Thinking/);
  const css = readFileSync(
    new URL("../../../shared/ui/react-bits/LatticeLoader.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none !important/);
});

test("center definitions and staff access render as separate workflows", async () => {
  const { default: Registry } =
    await import("../src/components/OperationalRegistry.jsx");
  const state = {
    scopes: [
      { id: "clinic", name: "Synthetic clinic", kind: "clinic", active: true },
    ],
    grants: [],
  };
  const definitions = renderToStaticMarkup(
    createElement(Registry, { state, api: {}, mode: "definitions" }),
  );
  assert.match(definitions, /Edit Synthetic clinic/);
  assert.doesNotMatch(
    definitions,
    /Explicit staff scope assignments|Save assignments/,
  );
  const access = renderToStaticMarkup(
    createElement(Registry, { state, api: {}, mode: "access" }),
  );
  assert.match(access, /Explicit staff scope assignments/);
  assert.doesNotMatch(access, /Add clinic\/service|Edit Synthetic clinic/);
});

test("Today marks unresolved work amber while a routine booking count stays neutral", async () => {
  const { default: Today } = await import("../src/components/Today.jsx");
  const html = renderToStaticMarkup(
    createElement(Today, {
      summary: {
        capabilities: { requests: true, bookingView: true },
        counts: {
          requestsAwaitingDecision: 2,
          messagesToSend: 1,
          todayBookings: 4,
        },
        activity: [],
      },
    }),
  );
  assert.match(
    html,
    /staff-today-card needs-action[^]*Requests awaiting decision/,
  );
  assert.match(
    html,
    /Today’s bookings<\/span><strong class="staff-neutral-count">4/,
  );
});
