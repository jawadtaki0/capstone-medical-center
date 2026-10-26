import test from "node:test";
import assert from "node:assert/strict";
import { assertLegacyReaderMode } from "../src/normal-publication.js";

test("omitted publication startup configuration cannot silently restore legacy reads after activation", async () => {
  const db = (value) => ({
    collection(name) {
      assert.equal(name, "public_data_authority");
      return { findOne: async () => value };
    },
  });
  await assertLegacyReaderMode(db(null));
  await assertLegacyReaderMode(db({ mode: "legacy", writesFrozen: true }));
  await assert.rejects(
    assertLegacyReaderMode(db({ mode: "cedar", streamId: "stream:synthetic" })),
    /explicit publication configuration/,
  );
  await assert.rejects(
    assertLegacyReaderMode(db({ mode: "unknown" })),
    /explicit publication configuration/,
  );
});
