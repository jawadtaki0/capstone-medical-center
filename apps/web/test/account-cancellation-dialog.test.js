import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("My account and Ask Cedar render the same appointment cancellation dialog", () => {
  for (const path of [
    "../src/pages/AccountProfiles.jsx",
    "../src/components/AssistantAccountCards.jsx",
  ]) {
    const component = source(path);
    assert.match(component, /from ".*BookingCancellationDialog\.jsx"/);
    assert.match(component, /<BookingCancellationDialog\b/);
    assert.doesNotMatch(component, /<CancellationForm\b/);
  }
});
