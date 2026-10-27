import test from "node:test";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import * as operator from "../scripts/public-transition.js";

const backup = (state) => ({
  database: "capstone_staff_test",
  collections: {
    operational_state: {
      exists: Boolean(state),
      raw: state ? [BSON.serialize(state)] : [],
    },
  },
});
test("normal import operator derives the exact working revision from the verified target backup", () => {
  assert.equal(typeof operator.importRevisionFromBackup, "function");
  assert.equal(operator.importRevisionFromBackup(backup(null)), 0);
  for (const revision of [0, 1, 47])
    assert.equal(
      operator.importRevisionFromBackup(
        backup({ _id: "working", revision, head: 0 }),
      ),
      revision,
    );
});
test("target backup revision extraction rejects ambiguous, unsafe and already-published state", () => {
  assert.equal(typeof operator.importRevisionFromBackup, "function");
  for (const state of [
    { _id: "wrong", revision: 1, head: 0 },
    { _id: "working", head: 0 },
    ...[-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER].map((revision) => ({
      _id: "working",
      revision,
      head: 0,
    })),
    { _id: "working", revision: 1, head: 1 },
  ])
    assert.throws(() => operator.importRevisionFromBackup(backup(state)));
  assert.throws(() => operator.importRevisionFromBackup({ collections: {} }));
  assert.throws(() =>
    operator.importRevisionFromBackup({
      collections: { operational_state: { raw: [] } },
    }),
  );
  const duplicate = backup({ _id: "working", revision: 1, head: 0 });
  duplicate.collections.operational_state.raw.push(
    BSON.serialize({ _id: "other", revision: 1, head: 0 }),
  );
  assert.throws(() => operator.importRevisionFromBackup(duplicate));
});
