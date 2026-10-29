import { assertIsolatedTestTarget } from "./security-fixture.js";

const PREFIX = "hosted_review_";
const CROSS_COLLECTION = new Set([
  "$lookup",
  "$graphLookup",
  "$unionWith",
  "$out",
  "$merge",
]);

function assertLocalPipeline(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (CROSS_COLLECTION.has(key))
      throw new Error(
        "Hosted review cross-collection aggregation is unsupported.",
      );
    assertLocalPipeline(child);
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
              assertLocalPipeline(pipeline);
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
