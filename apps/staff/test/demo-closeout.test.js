import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bookingAccess } from "../../staff-api/src/booking-model.js";
import { capabilitiesFor } from "../../staff-api/src/assistant/topics.js";
import { permissionsFor } from "../../staff-api/src/permissions.js";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("Clinic booking rights follow the role and assignment, and Directory stays Admin-only", () => {
  const clinic = { kind: "clinic", active: true, id: "clinic:orchard" };
  for (const [role, assigned, unassigned, directory] of [
    ["Admin", true, true, true],
    ["Clinic Admin", true, false, false],
    ["Lab Admin", false, false, false],
    ["Receptionist", true, false, false],
  ]) {
    assert.equal(bookingAccess([role], [clinic.id], clinic), assigned, role);
    assert.equal(
      bookingAccess([role], ["clinic:other"], clinic),
      unassigned,
      role,
    );
    assert.equal(
      bookingAccess([role], [clinic.id], { ...clinic, active: false }),
      false,
      role,
    );
    assert.equal(
      permissionsFor([role]).includes("staff:directory"),
      directory,
      role,
    );
  }
});

test("Staff AI offers Admin the existing Lab operations and preserves other role boundaries", () => {
  for (const [role, expected] of [
    ["Admin", [true, true, true, true, true]],
    ["Clinic Admin", [false, false, false, false, false]],
    ["Lab Admin", [true, true, true, true, true]],
    ["Receptionist", [true, true, false, false, false]],
  ]) {
    const { labOrder, labRelease, labPrepare, labManage, labWithdraw } =
      capabilitiesFor([role], {}, true);
    assert.deepEqual(
      [labOrder, labRelease, labPrepare, labManage, labWithdraw],
      expected,
      role,
    );
  }
});

test("The workspace distinguishes an unassigned Clinic from an empty queue and keeps a sync retry visible", () => {
  const workspace = source("../src/components/Workspace.jsx");
  assert.match(workspace, /No Clinic assignment/);
  assert.match(workspace, /Request sync unavailable/);
  assert.match(workspace, />\s*Retry\s*</);
});

test("Duplicate review has a same-person option in addition to the existing two choices", () => {
  const editor = source("../src/components/PatientEditor.jsx");
  assert.match(editor, /Open existing record/);
  assert.match(editor, /confirm this is a distinct/);
  assert.match(editor, /These may be the same person/);
  assert.match(editor, /authorized registry review/i);
});
