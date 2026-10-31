import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("one-date StrictMode saves close safely, preserve peer limits, and support keyboard/narrow controls", async () => {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({
      headless: true,
      channel: process.env.STAFF_UI_BROWSER_CHANNEL || "chrome",
    });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    page.on("pageerror", () => errors.push("renderer-error"));
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/fixtures/one-date-review.html`,
    );
    await page
      .getByRole("button", { name: "Change one date", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("What changes?", { exact: true })
      .selectOption("professional|one");
    await dialog.getByLabel("Change", { exact: true }).selectOption("closed");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await dialog
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 2000 });
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].revision, 0);
    assert.equal(calls[0].record.closed, false);
    assert.deepEqual(
      calls[0].record.sessions.map((s) => [s.id, s.capacity]),
      [["s2", null]],
    );
    await page
      .getByRole("button", { name: "Change one date", exact: true })
      .click();
    await dialog
      .getByLabel("What changes?", { exact: true })
      .selectOption("scope|clinic");
    await dialog.getByLabel("Change", { exact: true }).selectOption("closed");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Change one date", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(errors.length, 0);
  } finally {
    await browser?.close();
    await server.close();
  }
});
