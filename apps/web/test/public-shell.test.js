// Shared public shell regressions; no database or network access.
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

test("public shell owns one background and preserves its route content and safe footer action", async () => {
  const { default: PublicShell } =
    await import("../src/components/PublicShell.jsx");
  const previous = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  try {
    const html = renderToStaticMarkup(
      createElement(
        PublicShell,
        { homePage: false, onPreview() {}, onRequestPage: true },
        createElement("section", null, "Existing request content"),
      ),
    );
    assert.equal((html.match(/class="home-background"/g) || []).length, 1);
    assert.doesNotMatch(html, /<canvas|grainient-backdrop/);
    assert.match(html, /Existing request content/);
    assert.match(html, /href="\/schedule"/);
    assert.match(html, /href="\/#contact"/);
    const footer = html.slice(html.indexOf("<footer"));
    assert.match(footer, /<button[^>]*>Back to top/);
    assert.doesNotMatch(footer, /href="#main"/);
    assert.match(footer, /requests require reception confirmation/);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("shared navigation identifies published page location without turning service anchors into homepage-local links", async () => {
  const { default: Header } = await import("../src/components/Header.jsx");
  const previous = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  try {
    const html = renderToStaticMarkup(
      createElement(Header, {
        homePage: false,
        publicDesign: true,
        serviceSlug: "laboratory",
        onPreview() {},
      }),
    );
    assert.match(html, /href="\/services\/laboratory" aria-current="page"/);
    assert.match(html, /href="\/#services"/);
    assert.match(html, /Request a session/);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
