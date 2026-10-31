import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const sourceRoot = new URL("../src/", import.meta.url).href;
const sharedRoot = new URL("../../../shared/ui/", import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    if (
      !(url.startsWith(sourceRoot) || url.startsWith(sharedRoot)) ||
      !url.endsWith(".jsx")
    )
      return next(url, context);
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

test("request action counters distinguish zero, unknown and stale values without false amber", async () => {
  const { default: Count } =
    await import("../src/components/RequestActionCount.jsx");
  const render = (value, stale = false) =>
    renderToStaticMarkup(
      createElement(Count, {
        value,
        stale,
        label: "requests awaiting decision",
      }),
    );
  assert.match(render(3), /staff-action-count/);
  assert.match(render(0), /staff-neutral-count/);
  assert.doesNotMatch(render(0), /staff-action-count/);
  for (const unknown of [undefined, null, -1, NaN, "0", 0.5]) {
    assert.match(render(unknown), /count unavailable/);
    assert.match(render(unknown), /—/);
    assert.doesNotMatch(render(unknown), />0<|staff-action-count/);
  }
  assert.match(render(4, true), /last known count/);
  assert.match(render(4, true), />4</);
});

test("Requests and Messages tabs use independent authorized action totals; History has no action badge", async () => {
  const { default: Requests } =
    await import("../src/components/WebsiteRequests.jsx");
  const markup = renderToStaticMarkup(
    createElement(Requests, {
      api: {},
      initialView: "history",
      actionCounts: { requestsAwaitingDecision: 0, messagesToSend: 2 },
    }),
  );
  assert.match(markup, /0 requests awaiting decision/);
  assert.match(markup, /2 messages needing action/);
  const historyButton = markup.match(
    /<button[^>]*aria-pressed="true"[^>]*>(.*?)<\/button>/s,
  )?.[1];
  assert.equal(historyButton?.trim(), "History");
  assert.doesNotMatch(historyButton, /count|amber|needs-action/);
  const unknown = renderToStaticMarkup(
    createElement(Requests, { api: {}, initialView: "requests" }),
  );
  assert.match(unknown, /requests awaiting decision: count unavailable/);
  assert.match(unknown, /messages needing action: count unavailable/);
});

test("sidebar counter rows wrap separately and active navigation retains its blue precedence", () => {
  const css = readFileSync(
    new URL("../src/components/today.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.staff-request-sidebar-counts\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.staff-request-count-row\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(
    css,
    /\.staff-sidebar-link\.needs-action:not\(\[aria-current="page"\]\)/,
  );
  const workspace = readFileSync(
    new URL("../src/components/Workspace.jsx", import.meta.url),
    "utf8",
  );
  assert.match(workspace, /actionCounts=\{summary\?\.counts\}/);
  assert.match(workspace, /Requests awaiting decision/);
  assert.match(workspace, /Messages to send/);
});
