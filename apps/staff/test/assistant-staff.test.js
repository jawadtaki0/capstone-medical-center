import test from "node:test";
import assert from "node:assert/strict";
import { readRoles, createdNote } from "../src/lib/assistantStaff.js";

test("only roles that were named are pre-ticked", () => {
  assert.deepEqual(readRoles("create an account as receptionist"), [
    "Receptionist",
  ]);
  assert.deepEqual(readRoles("new lab admin account"), ["Lab Admin"]);
  assert.deepEqual(readRoles("add a clinic admin and receptionist"), [
    "Clinic Admin",
    "Receptionist",
  ]);
  assert.deepEqual(readRoles("create an admin account"), ["Admin"]);
  assert.deepEqual(readRoles("حساب موظف استقبال"), ["Receptionist"]);
  assert.deepEqual(readRoles("create a staff account"), []);
});

test("the note kept in the chat never carries the setup code", () => {
  const note = createdNote("en", {
    account: { username: "maya.najdi" },
    setupCode: "SECRET-CODE",
    expiresAt: "2026-11-27T10:00:00Z",
  });
  assert.match(note, /maya\.najdi/);
  assert.doesNotMatch(note, /SECRET-CODE/);
});
