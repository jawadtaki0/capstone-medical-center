import { createServer } from "node:http";
if (!process.send || !process.argv.includes("--synthetic-owned-fixture"))
  throw new Error("Owned synthetic fixture required.");
let released = false;
const server = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({ service: "synthetic-launcher-test", healthy: true }),
  );
  if (request.url === "/finish-owned-test") setImmediate(stop);
});
function stop() {
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on("message", (message) => {
  if (message?.type === "stop") stop();
  if (message?.type === "prepare-release") {
    process.send({ type: "release-ready" });
  }
  if (message?.type === "release") {
    released = true;
    process.send({ type: "released" });
  }
});
process.on("disconnect", () => {
  if (!released) stop();
});
server.listen(0, "127.0.0.1", () =>
  process.send({ type: "fixture-ready", port: server.address().port }),
);
// Own bounded safeguard, even if the test runner is interrupted after handoff.
setTimeout(stop, 20000).unref();
