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

test("the release form is offered to every role that may release", async () => {
  const { default: LabReport } = await import(
    "../src/components/LabReport.jsx"
  );
  const order = {
    status: "Ready to release",
    tests: [],
    reportVersions: [{ id: "r1", version: 1, status: "Finalized" }],
  };
  const offers = (role) =>
    renderToStaticMarkup(
      createElement(LabReport, {
        order,
        catalogue: [],
        roles: [role],
        change: () => {},
      }),
    ).includes("Release report");
  for (const role of ["Admin", "Lab Admin", "Receptionist"])
    assert.equal(offers(role), true, role);
  assert.equal(offers("Clinic Admin"), false);
});
