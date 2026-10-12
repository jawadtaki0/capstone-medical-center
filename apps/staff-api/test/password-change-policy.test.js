import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPasswordWorkGate,
  PASSWORD_CHANGE_POLICY,
  passwordChangeInput,
} from "../src/password-change.js";

test("approved password-change work gate refuses rather than queues", () => {
  const gate = createPasswordWorkGate();
  const a = gate.acquire("a"),
    b = gate.acquire("b");
  assert.throws(() => gate.acquire("c"), { code: "password_change_busy" });
  assert.throws(() => gate.acquire("a"), { code: "password_change_busy" });
  a();
  a();
  const c = gate.acquire("c");
  b();
  c();
  assert.equal(PASSWORD_CHANGE_POLICY.jobsPerProcess, 2);
});
test("confirmation is exact and actual passwords are not normalized", () => {
  const value = "  Unusual violet river password  ";
  assert.equal(
    passwordChangeInput(
      { newPassword: value, confirmation: value },
      "employee",
    ),
    value,
  );
  assert.throws(
    () =>
      passwordChangeInput({ newPassword: value, confirmation: value.trim() }),
    { code: "invalid_input" },
  );
  assert.throws(
    () => passwordChangeInput({ newPassword: "short", confirmation: "short" }),
    { code: "invalid_input" },
  );
  assert.throws(
    () =>
      passwordChangeInput({
        newPassword: value,
        confirmation: value,
        accountId: "another",
      }),
    { code: "invalid_input" },
  );
});
