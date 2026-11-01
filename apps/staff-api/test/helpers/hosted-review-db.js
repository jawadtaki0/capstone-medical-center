import { assertIsolatedTestTarget } from "./security-fixture.js";

const PREFIX = "hosted_review_";
const CROSS_COLLECTION = new Set([
  "$lookup",
  "$graphLookup",
  "$unionWith",
  "$out",
  "$merge",
]);

function summaryLookup(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      "as,foreignField,from,localField,pipeline"
  )
    return false;
  if (
    value.from !== PREFIX + "website_request_inbox" ||
    value.localField !== "requestId" ||
    value.foreignField !== "_id" ||
    value.as !== "request"
  )
    return false;
  if (
    !Array.isArray(value.pipeline) ||
    value.pipeline.length !== 1 ||
    Object.keys(value.pipeline[0]).join() !== "$project"
  )
    return false;
  const p = value.pipeline[0].$project;
  return (
    [
      "_id,expiresAt,generation,purgedAt,rotation,scopeId,sequence",
      "purgedAt,scopeId",
    ].includes(Object.keys(p).sort().join()) &&
    Object.values(p).every((v) => v === 1)
  );
}
function assertLocalPipeline(value, source) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "$lookup" &&
      ["website_request_notices", "website_request_events"].includes(source) &&
      summaryLookup(child)
    )
      continue;
    if (CROSS_COLLECTION.has(key))
      throw new Error(
        "Hosted review cross-collection aggregation is unsupported.",
      );
    assertLocalPipeline(child, source);
  }
}

// Logical separation for trusted review code, not a MongoDB authorization
// sandbox: the supplied client still has TEST-database privileges. Never pass
// arbitrary renderer input as collection names, commands or aggregation stages.
export function createHostedReviewDatabase(connection) {
  assertIsolatedTestTarget(connection);
  const original = connection.db;
  return Object.freeze({
    databaseName: original.databaseName,
    collection(name) {
      assertIsolatedTestTarget(connection);
      if (
        typeof name !== "string" ||
        !/^[a-z][a-z0-9_]{0,95}$/.test(name) ||
        name.startsWith(PREFIX) ||
        name.startsWith("system_")
      )
        throw new Error("Unsupported hosted review collection name.");
      const target = original.collection(PREFIX + name);
      return new Proxy(target, {
        get(collection, property) {
          if (["rename", "mapReduce", "watch"].includes(property))
            return () => {
              throw new Error(
                "Hosted review collection operation unsupported.",
              );
            };
          if (property === "aggregate")
            return (pipeline, options) => {
              if (!Array.isArray(pipeline))
                throw new Error(
                  "Hosted review cross-collection aggregation is unsupported.",
                );
              assertLocalPipeline(pipeline, name);
              return collection.aggregate(pipeline, options);
            };
          const value = Reflect.get(collection, property);
          return typeof value === "function" ? value.bind(collection) : value;
        },
      });
    },
    command(value) {
      assertIsolatedTestTarget(connection);
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).length !== 1 ||
        value.ping !== 1
      )
        throw new Error(
          "Hosted review database commands support exact ping only.",
        );
      return original.command({ ping: 1 });
    },
  });
}
