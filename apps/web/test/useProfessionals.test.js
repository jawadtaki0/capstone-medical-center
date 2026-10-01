import test from "node:test";
import assert from "node:assert/strict";
import { loadProfessionals } from "../src/hooks/useProfessionals.js";

const profile = { id: "test:specialist:one", name: "Sample Specialist", specialty: "Dietitian", kind: "specialist", avatarVariant: "female" };
test("directory loading requests the public endpoint once and validates its response", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const result = await loadProfessionals(signal, async (url, options) => {
    calls += 1;
    assert.equal(url, "/api/professionals");
    assert.equal(options.signal, signal);
    return { ok: true, json: async () => ({ professionals: [profile] }) };
  });
  assert.deepEqual(result, [profile]);
  assert.equal(calls, 1);
});
test("failure is not replaced by invented profiles and a new request can retry", async () => {
  let calls = 0;
  const request = async () => ++calls === 1 ? { ok: false } : { ok: true, json: async () => ({ professionals: [profile] }) };
  await assert.rejects(loadProfessionals(undefined, request), /request failed/);
  assert.deepEqual(await loadProfessionals(undefined, request), [profile]);
});
test("empty data remains genuinely empty and malformed data fails", async () => {
  assert.deepEqual(await loadProfessionals(undefined, async () => ({ ok: true, json: async () => ({ professionals: [] }) })), []);
  await assert.rejects(loadProfessionals(undefined, async () => ({ ok: true, json: async () => ({ doctors: [profile] }) })), /invalid/);
});
