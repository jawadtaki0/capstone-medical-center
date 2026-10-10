import { app } from "electron";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createLauncherWindow } from "../../launcher/main.js";

// Native-window fixture only: no configuration, database, accounts or delivery.
app.setPath(
  "userData",
  join(app.getPath("temp"), `cedar-launcher-ui-test-${process.pid}`),
);
app.on("window-all-closed", () => app.quit());
const runner = new EventEmitter();
runner.connected = true;
runner.send = (message) => {
  if (message?.type === "cancel") {
    globalThis.cancelCount++;
    runner.emit("message", {
      type: "failure",
      message:
        "Startup cancelled. Only services started by this attempt were cleaned up.",
    });
  }
};
globalThis.cancelCount = 0;
globalThis.launcherFixture = runner;
void app.whenReady().then(() => {
  void createLauncherWindow({
    makeRunner: () =>
      new Promise((resolve) => {
        globalThis.resolveFixtureRunner = () => resolve(runner);
      }),
  });
});
