import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

export async function verifyPasswordMeter({
  artifact,
  origin,
  callAccount,
  db,
  seedAccount,
  mailbox,
  patientAccounts,
  reviewPassword,
  advanceHour,
}) {
  const phone = "+12025550142";
  const { email } = await seedAccount("password-meter", phone, false);
  const accounts = db.collection("patient_accounts");
  await accounts.updateOne(
    { email },
    { $set: { verifiedPersonalPhone: phone } },
  );
  async function emailReset() {
    advanceHour();
    await callAccount("recover", { email, language: "en" });
    const link = mailbox.at(-1).link;
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
    return { link, token };
  }
  const { link, token } = await emailReset();
  const rejectReuse = async (action, proof, password) => {
    const before = await accounts.findOne({ email });
    assert.equal(
      (await callAccount(action, { ...proof, password }, { status: 409 }))
        .result.error,
      "password_reused",
    );
    assert.deepEqual(await accounts.findOne({ email }), before);
  };
  await rejectReuse("reset", { token }, reviewPassword);

  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const evidence = resolve(artifact, "evidence");
    await mkdir(evidence, { recursive: true });
    await page.goto(origin + "/account");
    const signInPassword = page.locator('input[name="password"]');
    const eye = page.getByRole("button", {
      name: "Show password",
      exact: true,
    });
    await signInPassword.fill(reviewPassword);
    await eye.focus();
    await page.keyboard.press("Space");
    assert.equal(await signInPassword.getAttribute("type"), "text");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement.getAttribute("aria-label"),
      ),
      "Hide password",
    );
    await page.keyboard.press("Space");
    assert.equal(await signInPassword.getAttribute("type"), "password");

    await page.goto(link);
    const field = page.locator('input[name="password"]');
    const strength = page.locator(".patient-password-strength");
    const status = strength.getByRole("status");
    const segment = strength
      .locator(".patient-password-track > span > span")
      .first();
    async function capture(name) {
      await strength.evaluate((node) =>
        Promise.all(
          node
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        ),
      );
      await page.screenshot({ path: resolve(evidence, name) });
    }
    await field.pressSequentially("abc");
    assert.equal(await status.textContent(), "Weak");
    assert.ok(
      parseFloat(await segment.evaluate((node) => node.style.inlineSize)) < 100,
    );
    await capture("weak-desktop.png");
    await field.pressSequentially("DEF12");
    assert.equal(await status.textContent(), "Medium");
    await capture("medium-desktop.png");
    await field.pressSequentially("!Ghijk");
    assert.equal(await status.textContent(), "Strong");
    assert.equal(
      await segment.evaluate(
        (node) => getComputedStyle(node).transitionDuration,
      ),
      "0.22s, 0.22s",
    );
    await capture("strong-desktop.png");
    for (let erase = 0; erase < 6; erase++) await field.press("Backspace");
    assert.equal(await status.textContent(), "Medium");
    for (let erase = 0; erase < 5; erase++) await field.press("Backspace");
    assert.equal(await status.textContent(), "Weak");

    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await segment.evaluate(
        (node) => getComputedStyle(node).transitionDuration,
      ),
      "0s",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("combobox", { name: "Page language" })
      .selectOption("ar");
    await field.fill("Cedar review replacement number 1!");
    assert.equal(await status.textContent(), "قوية");
    assert.equal(
      await strength.evaluate((node) => getComputedStyle(node).direction),
      "rtl",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      390,
    );
    await page.screenshot({
      path: resolve(evidence, "strong-mobile-ar.png"),
      fullPage: true,
    });
    await page.getByRole("combobox", { name: "لغة الصفحة" }).selectOption("en");
    const confirm = page.locator('input[name="confirmPassword"]');
    await confirm.fill("Different password entered!");
    const submit = page.getByRole("button", {
      name: "Set a new password",
      exact: true,
    });
    await submit.click();
    await page.getByText("Passwords do not match.").waitFor();
    await confirm.fill(await field.inputValue());
    await submit.click();
    await page
      .getByText("Password updated. Sign in with your new password.")
      .waitFor();
  } finally {
    await browser.close();
  }

  await callAccount("phone-recover", { phone, language: "en" });
  const staff = (body) => patientAccounts.phoneVerification.staff(body);
  const recoveryId = (await accounts.findOne({ email })).recoveryPhone.id;
  const draft = await staff({ action: "prepare", id: recoveryId });
  const code = draft.message.match(/\b\d{6}\b/)[0];
  await staff({ action: "opened", id: recoveryId });
  await rejectReuse("phone-reset", { phone, code }, reviewPassword);
  await rejectReuse(
    "phone-reset",
    { phone, code },
    "Cedar review replacement number 1!",
  );
  let current = "Cedar review replacement number 2!";
  await callAccount("phone-reset", { phone, code, password: current });
  await callAccount(
    "phone-reset",
    { phone, code, password: current },
    { status: 400 },
  );
  await callAccount("signin", { identifier: email, password: current });
  await callAccount(
    "signin",
    { identifier: email, password: "Cedar review replacement number 1!" },
    { status: 401 },
  );

  for (let number = 3; number <= 6; number++) {
    const proof = { token: (await emailReset()).token };
    await rejectReuse("reset", proof, reviewPassword);
    current = `Cedar review replacement number ${number}!`;
    await callAccount("reset", { ...proof, password: current });
  }
  const row = await accounts.findOne({ email });
  assert.equal(row.passwordHistory.length, 5);
  const proof = { token: (await emailReset()).token };
  await rejectReuse("reset", proof, "Cedar review replacement number 1!");
  await callAccount("reset", { ...proof, password: reviewPassword });
  const updated = await accounts.findOne({ email });
  assert.equal(updated.passwordHistory.length, 5);
  assert.equal(updated.passwordHistory[0], row.passwordHash);
  assert.equal(updated.recovery, undefined);
  console.log(
    "PASS keyboard eye, animated up/down strength, mobile Arabic RTL, reduced motion, confirmation, email and WhatsApp password history, proof retention and five-hash rollover",
  );
}
