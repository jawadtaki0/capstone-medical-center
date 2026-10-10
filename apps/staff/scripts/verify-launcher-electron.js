import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { _electron as electron } from "playwright";

const entry = resolve("apps/staff/test/helpers/launcher-window-fixture.js");
const executablePath = resolve("node_modules/electron/dist/electron.exe");
const errors = [];
const requests = [];
let checks = 0;
async function client() {
  console.log("Opening owned dummy launcher window…");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const value = await electron.launch({
    executablePath,
    args: [entry],
    env,
    timeout: 15000,
  });
  let page;
  try {
    page = await value.firstWindow({ timeout: 10000 });
  } catch (error) {
    value.process().kill();
    throw error;
  }
  page.setDefaultTimeout(10000);
  page.on("pageerror", () => errors.push("renderer error"));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /Electron Security Warning/.test(message.text())
    )
      errors.push("runtime/security error");
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push("external request");
  });
  await page.waitForSelector("#cancel");
  return { value, page };
}
async function send(value, type, message) {
  await value.evaluate(
    (_electron, payload) => globalThis.launcherFixture.emit("message", payload),
    { type, message },
  );
}
async function closeClient(value) {
  // Fixture teardown only. Destroy owned dummy windows after the assertions;
  // app.quit alone cannot close a launcher awaiting its injected worker.
  try {
    await value.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    });
    await value.close();
  } catch {}
}
async function fits(page) {
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
    true,
  );
  checks++;
}
async function motion(page, reduced = false) {
  const state = await page.evaluate(() => ({
    dots: [...document.querySelectorAll(".startup-dots span")].map(
      (dot) => getComputedStyle(dot).animationName,
    ),
    label: getComputedStyle(document.getElementById("status-label"))
      .animationName,
    hidden: document.querySelector(".startup-dots").getAttribute("aria-hidden"),
    live: document.getElementById("status").getAttribute("aria-live"),
  }));
  assert.deepEqual(state.dots, Array(3).fill(reduced ? "none" : "startup-dot"));
  assert.equal(state.label, reduced ? "none" : "startup-label");
  assert.equal(state.hidden, "true");
  assert.equal(state.live, "polite");
  checks++;
}
const first = await client();
try {
  assert.equal(
    await first.page
      .locator("#cancel")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  checks++;
  // Cancel while worker construction is still pending must be remembered.
  await first.page.keyboard.press("Escape");
  await first.value.evaluate(() => globalThis.resolveFixtureRunner());
  await first.page
    .getByRole("button", { name: "Close", exact: true })
    .waitFor();
  assert.equal(await first.value.evaluate(() => globalThis.cancelCount), 1);
  checks++;
  assert.match(await first.page.locator("#status").textContent(), /cancelled/i);
  checks++;
  assert.equal(await first.page.locator(".startup-dots").isVisible(), false);
  checks++;
  await fits(first.page);
} finally {
  await closeClient(first.value);
}

const second = await client();
try {
  await second.value.evaluate(() => globalThis.resolveFixtureRunner());
  await send(second.value, "progress", "Checking staff server");
  await second.page.locator('#server[data-state="current"]').waitFor();
  checks++;
  await send(second.value, "progress", "Opening Cedar Staff");
  assert.equal(await second.page.locator("#cancel").isDisabled(), true);
  checks++;
  await second.page.keyboard.press("Escape");
  assert.equal(await second.value.evaluate(() => globalThis.cancelCount), 0);
  checks++;
  await send(
    second.value,
    "failure",
    "The selected packaged Cedar Staff application is missing. Build/select that package and update the shortcut settings. Nothing was downloaded or reset.",
  );
  await second.page
    .getByRole("button", { name: "Close", exact: true })
    .waitFor();
  assert.equal(
    await second.page
      .locator("#cancel")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  checks++;
  await second.value.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(390, 440),
  );
  assert.equal(await second.page.locator(".startup-dots").isVisible(), false);
  checks++;
  await fits(second.page);
  await mkdir("apps/staff/test-results/launcher", { recursive: true });
  await second.page.screenshot({
    path: "apps/staff/test-results/launcher/error-window.png",
  });
} finally {
  await closeClient(second.value);
}

const third = await client();
try {
  await motion(third.page);
  // Hold dummy progress long enough to inspect genuine native-window motion.
  const moving = await third.page.evaluate(async () => {
    const animation = document
      .querySelector(".startup-dots span")
      .getAnimations()[0];
    const before = animation.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 350));
    return animation.currentTime > before;
  });
  assert.equal(moving, true);
  checks++;
  await third.value.evaluate(() => globalThis.resolveFixtureRunner());
  await send(third.value, "progress", "Checking staff server");
  await third.page.locator('#server[data-state="current"]').waitFor();
  await motion(third.page);
  assert.equal(
    await third.page.locator("#database").getAttribute("aria-label"),
    "Database: completed",
  );
  assert.equal(
    await third.page.locator("#server").getAttribute("aria-current"),
    "step",
  );
  assert.equal(
    await third.page.locator("#database .step-check").isVisible(),
    true,
  );
  assert.equal(
    await third.page.locator("#server .step-check").isVisible(),
    false,
  );
  checks++;
  await third.page.evaluate(async () => {
    await Promise.all(
      document
        .getElementById("status-label")
        .getAnimations()
        .map((animation) => animation.finished),
    );
  });
  await send(third.value, "progress", "Checking staff server");
  assert.equal(
    await third.page
      .locator("#status-label")
      .evaluate((node) => node.getAnimations().length),
    0,
  );
  checks++;
  await third.page.emulateMedia({ reducedMotion: "reduce" });
  await send(third.value, "progress", "Opening Cedar Staff");
  await motion(third.page, true);
  assert.equal(await third.page.locator(".startup-dots").isVisible(), true);
  checks++;
  await third.page.emulateMedia({ reducedMotion: "no-preference" });
  await send(third.value, "progress", "Checking staff server");
  await third.value.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(390, 345),
  );
  await fits(third.page);
  await third.page.screenshot({
    path: "apps/staff/test-results/launcher/progress-window.png",
  });
  const closed = third.value.waitForEvent("close");
  await send(
    third.value,
    "complete",
    "Cedar Staff opened. Local services remain running.",
  );
  await closed;
  checks++;
} finally {
  await closeClient(third.value);
}
assert.deepEqual(errors, []);
assert.deepEqual(requests, []);
console.log(
  `PASS: ${checks} actual Electron launcher checks; pending-worker cancellation, keyboard/focus, steps, handoff, errors and narrow wrapping. No renderer HTTP requests or runtime/security errors. Mock workers only; no accounts/services/configuration.`,
);
