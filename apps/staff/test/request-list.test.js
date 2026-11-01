import test from "node:test";
import assert from "node:assert/strict";
import { createRequestListLoader } from "../src/lib/requestList.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
test("rapid Requests / Messages / History switches discard older responses and errors", async () => {
  const loader = createRequestListLoader(),
    pending = [deferred(), deferred(), deferred()],
    commits = [],
    errors = [],
    finished = [];
  const jobs = pending.map((job, n) =>
    loader.load(
      () => job.promise,
      ["requests", "messages", "history"][n],
      {},
      (rows) => commits.push(rows),
      (e) => errors.push(e),
      () => finished.push(n),
    ),
  );
  pending[2].resolve({ notices: [{ id: "latest" }], nextCursor: null });
  pending[1].reject(new Error("obsolete failure"));
  pending[0].resolve({ requests: [{ id: "old", patient: {}, selection: {} }] });
  await Promise.all(jobs);
  assert.deepEqual(commits, [[{ id: "latest" }]]);
  assert.deepEqual(errors, []);
  assert.deepEqual(finished, [2]);
});
test("cancellation/unmount rejects delayed results; empty is a successful response", async () => {
  const loader = createRequestListLoader(),
    job = deferred();
  let commits = 0;
  const promise = loader.load(
    () => job.promise,
    "requests",
    {},
    () => commits++,
    assert.fail,
    () => {},
  );
  loader.invalidate();
  job.resolve({ requests: [] });
  await promise;
  assert.equal(commits, 0);
  await loader.load(
    async () => ({ requests: [] }),
    "requests",
    {},
    (rows) => assert.deepEqual(rows, []),
    assert.fail,
    () => commits++,
  );
  assert.equal(commits, 1);
});
test("wrong list shape and current authorization failure reach controlled error handling", async () => {
  const loader = createRequestListLoader();
  const errors = [];
  await loader.load(
    async () => ({ notices: [{ id: "notice" }] }),
    "requests",
    {},
    assert.fail,
    (e) => errors.push(e.message),
    () => {},
  );
  await loader.load(
    async () => {
      throw Object.assign(new Error("Sign in again"), {
        code: "session_expired",
      });
    },
    "history",
    {},
    assert.fail,
    (e) => errors.push(e.code),
    () => {},
  );
  assert.deepEqual(errors, [
    "The server returned an unreadable list. Please retry.",
    "session_expired",
  ]);
});
