import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createApp } from "../src/app.js";

async function withServer(action, overrides = {}) {
  const server = createServer(
    createApp({
      publicDataGate: { status: () => "ready", guard: (handler) => handler },
      publicationReceiver: {
        authorized: () => true,
        accept: async (body) => ({ accepted: body }),
        health: async () => "connected",
      },
      websiteRequests: {
        credential: "synthetic-only",
        service: { submit: async (body) => ({ received: body }) },
      },
      ...overrides,
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const send = (path, compressed = false, value = { value: "synthetic" }) =>
    new Promise((resolve, reject) => {
      const body = compressed
        ? gzipSync(JSON.stringify(value))
        : Buffer.from(JSON.stringify(value));
      const req = request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            ...(compressed ? { "Content-Encoding": "gzip" } : {}),
          },
        },
        (res) => {
          let output = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            output += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: JSON.parse(output),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    await action(send, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("public JSON boundaries reject compressed input without invoking decompression and preserve ordinary JSON", async () => {
  await withServer(async (send) => {
    for (const path of ["/api/publications", "/api/requests/submit"]) {
      const rejected = await send(path, true);
      assert.equal(rejected.status, 400, path);
      assert.equal(JSON.stringify(rejected.body).includes("stack"), false);
      const accepted = await send(path);
      assert.equal(accepted.status, 200, path);
      assert.deepEqual(
        accepted.body[path.includes("publications") ? "accepted" : "received"],
        { value: "synthetic" },
      );
    }
    const global = await send("/api/not-a-route", true);
    assert.equal(global.status, 415);
    assert.equal(global.body.error, "invalid_json");
    assert.equal((await send("/api/not-a-route")).status, 404);
  });
});

test("schedule failures use controlled logs without exception or private configuration contents", async () => {
  const logs = [],
    original = console.error;
  console.error = (message) => logs.push(String(message));
  try {
    await withServer(
      async (_send, server) => {
        const result = await fetch(
          `http://127.0.0.1:${server.address().port}/api/schedule?date=2026-11-02`,
        );
        assert.equal(result.status, 503);
        assert.equal(
          (await result.text()).includes("dummy-sensitive-value"),
          false,
        );
        assert.deepEqual(logs, ["Schedule read failed."]);
      },
      {
        publicationReceiver: null,
        scheduleReader: async () => {
          throw Error("dummy-sensitive-value");
        },
      },
    );
  } finally {
    console.error = original;
  }
});
