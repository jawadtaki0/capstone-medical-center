import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { _electron as electron } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";
import { PATIENT_LABELS } from "../shared/patient-input.js";
import { signInSynthetic } from "../../staff-api/test/helpers/publication-authority.js";

const artifact = resolve(".local/lab-review");
const pdfDirectory = resolve("Lab PDFs");
const staged = resolve(artifact, "app");
const lockPath = resolve(".local/professional-schedule-review/review.lock");
const spec = {
  name: "Synthetic result",
  unit: "demo",
  reference: "Synthetic only",
};
const interactive = process.argv.includes("--interactive");
const reportReview = process.argv.includes("--report");
const familyReview = process.argv.includes("--family");
const noticeIndex = process.argv.indexOf("--notice");
const noticeScenario =
  noticeIndex === -1 ? undefined : process.argv[noticeIndex + 1];
if (noticeIndex !== -1)
  assert.ok(
    familyReview &&
      interactive &&
      [
        "recollection",
        "cancellation",
        "release",
        "withdrawal",
        "corrected",
      ].includes(noticeScenario),
  );
const packageIndex = process.argv.indexOf("--package");
const executable =
  packageIndex === -1 ? undefined : resolve(process.argv[packageIndex + 1]);
if (executable) {
  const path = relative(resolve("apps/staff/release"), executable);
  assert.ok(
    path &&
      !isAbsolute(path) &&
      !path.startsWith(".." + sep) &&
      path.endsWith(sep + "Cedar Staff Development.exe"),
  );
}
let lock, fixture, desktop, proxy, familyReviewServer;
try {
  await mkdir(resolve(lockPath, ".."), { recursive: true });
  lock = await open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, kind: "lab-synthetic-review" }),
  );
  proxy = createServer(async (request, response) => {
    try {
      const parts = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 16384) throw Error("Oversized TEST request");
        parts.push(part);
      }
      const upstream = await fixture.request(request.url, {
        method: request.method,
        token: request.headers.authorization?.replace(/^Bearer /, ""),
        originHeader: request.headers.origin ?? "app://staff",
        ...(size ? { body: JSON.parse(Buffer.concat(parts).toString()) } : {}),
      });
      response.writeHead(upstream.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(upstream.body));
    } catch {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "authority_unavailable",
            message: "Synthetic Lab API unavailable.",
          },
        }),
      );
    }
  });
  proxy.listen(4101, "127.0.0.1");
  await once(proxy, "listening");
  await mkdir(staged, { recursive: true });
  await cp("apps/staff/package.json", resolve(staged, "package.json"));
  await cp("apps/staff/electron", resolve(staged, "electron"), {
    recursive: true,
  });
  await cp(resolve(artifact, "web"), resolve(staged, "dist"), {
    recursive: true,
  });
  process.env.CEDAR_LAB_REVIEW = "1";
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
    await readLauncherConfig()
  ).runtimeDirectory;
  const { createSecurityFixture } = await import(
    "../../staff-api/test/helpers/security-fixture.js"
  );
  fixture = await createSecurityFixture(
    familyReview
      ? {
          collectionPrefix:
            "lab_review_" + randomUUID().replaceAll("-", "") + "_",
        }
      : {},
  );
  await fixture.reset();
  const lab = await signInSynthetic(fixture, ["Lab Admin"]);
  const reception = await signInSynthetic(fixture, ["Receptionist"]);
  async function post(actor, path, body) {
    const result = await fixture.request(path, {
      method: "POST",
      token: actor.token,
      body,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  for (const [name, specimen, group] of [
    ["Synthetic A", "Blood", "Shared tube"],
    ["Synthetic B", "Blood", "Shared tube"],
    ["Synthetic C", "Urine", ""],
  ]) {
    const test = await post(lab, "/lab", {
      action: "save",
      name,
      specimen,
      group,
      fields: [spec],
    });
    await post(lab, "/lab", {
      action: "approve",
      id: test._id,
      revision: test.revision,
      reason: "Fictional review approval",
    });
  }
  const record = {
    firstName: "Synthetic",
    fatherName: "Father",
    lastName: "Labreview",
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: familyReview ? "+12025550147" : "+12025550142",
    gender: "female",
  };
  const { reviewDigest } = await post(reception, "/patients/check", { record });
  const { patient } = await post(reception, "/patients/create", {
    record,
    reviewDigest,
  });
  const actor =
    reportReview || process.argv.includes("--lab-admin")
      ? await fixture.account({ roles: ["Lab Admin"], mfa: true })
      : reception;
  if (reportReview || familyReview)
    await mkdir(pdfDirectory, { recursive: true });
  desktop = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(!executable ? [staged] : []),
      "--demo-loopback",
      "--user-data-dir=" + resolve(artifact, "profile"),
    ],
    env: {
      ...process.env,
      STAFF_API_URL: "http://127.0.0.1:4101",
      ...(reportReview || familyReview
        ? { CEDAR_LAB_PDF_DIRECTORY: pdfDirectory }
        : {}),
    },
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(12000);
  async function signIn(account) {
    await page.getByLabel("Username", { exact: true }).fill(account.username);
    const lockup = page.getByRole("img", {
      name: "Cedar Medical Center · مركز سيدر الطبي",
    });
    assert.ok(
      await lockup.evaluate(
        (image) => image.complete && image.naturalWidth === 620,
      ),
    );
    await page
      .getByLabel("Password or passphrase", { exact: true })
      .fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    if (account.secret) {
      await page
        .getByLabel("Authenticator code", { exact: true })
        .fill(await fixture.totp(account.secret));
      await page
        .getByRole("button", { name: "Verify and continue", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Lab", exact: true }).click();
    await page.getByRole("heading", { name: "Today’s orders" }).waitFor();
  }
  await signIn(actor);
  const recollectedReview =
    actor === reception && process.argv.includes("--recollected");
  if (familyReview) {
    const { startFamilyReview } = await import("./family-review.mjs");
    familyReviewServer = await startFamilyReview({
      fixture,
      reception,
      lab,
      patient,
      post,
      interactive,
      noticeScenario,
    });
    if (interactive && !noticeScenario)
      await page.getByRole("button", { name: "Patients", exact: true }).click();
    await familyReviewServer.verify(page, desktop);
    if (noticeScenario) {
      await page.getByRole("button", { name: "Refresh orders" }).click();
      await page
        .getByRole("button", {
          name: "LAB-" + familyReviewServer.orderId,
          exact: true,
        })
        .click();
      await page.getByText("WhatsApp delivery", { exact: true }).click();
    } else if (interactive) {
      console.log(
        "Complete the Reception and website checks. Press Enter here to switch Staff to Lab Admin for the withdrawal check.",
      );
      const terminal = createInterface({ input: process.stdin });
      try {
        await once(terminal, "line");
      } finally {
        terminal.close();
      }
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await signIn(await fixture.account({ roles: ["Lab Admin"], mfa: true }));
      await page
        .getByRole("button", {
          name: "LAB-" + familyReviewServer.orderId,
          exact: true,
        })
        .click();
      console.log(
        "Review or withdraw the report as Lab Admin. Press Enter to return to Reception.",
      );
      const withdrawal = createInterface({ input: process.stdin });
      try {
        await once(withdrawal, "line");
      } finally {
        withdrawal.close();
      }
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await signIn(await fixture.account({ roles: ["Receptionist"] }));
      await page
        .getByRole("button", {
          name: "LAB-" + familyReviewServer.orderId,
          exact: true,
        })
        .click();
    }
  } else if (actor === reception && !recollectedReview && interactive) {
    await page
      .getByRole("button", { name: "New order", exact: true })
      .waitFor();
  } else if (actor === reception && !recollectedReview) {
    assert.equal(
      await page
        .getByRole("button", { name: "Catalogue", exact: true })
        .count(),
      0,
    );
    await page.getByRole("button", { name: "New order", exact: true }).click();
    await page
      .getByLabel("Patient number", { exact: true })
      .fill(patient.patientNumber);
    await page
      .getByRole("button", { name: "Find patient", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open patient", exact: true })
      .click();
    if (!interactive) {
      await page
        .getByLabel("Patient number", { exact: true })
        .fill("P-99999999");
      await page
        .getByRole("button", { name: "Find patient", exact: true })
        .click();
      await page.getByText(/^No patient matched that number/).waitFor();
      await page
        .getByRole("button", { name: "Register patient", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const newcomer = {
        ...record,
        firstName: "Fictional",
        lastName: "Walkinexample",
        phone: "+12025550143",
      };
      for (const [key, value] of Object.entries(newcomer)) {
        const field = dialog.getByLabel(PATIENT_LABELS[key], { exact: true });
        if (key === "gender") await field.selectOption(value);
        else await field.fill(value);
      }
      await dialog
        .getByRole("button", {
          name: "Check for existing patient",
          exact: true,
        })
        .click();
      await dialog
        .getByText(/Select Save patient and return to order/)
        .waitFor();
      const unsaved = await post(reception, "/patients/search", {
        firstName: newcomer.firstName,
        lastName: newcomer.lastName,
      });
      assert.equal(unsaved.patients.length, 0);
      await dialog
        .getByRole("button", {
          name: "Save patient and return to order",
          exact: true,
        })
        .click();
      await page
        .getByText(/^Selected patient: Fictional Walkinexample/)
        .waitFor();
    }
    for (const name of ["Synthetic A", "Synthetic B", "Synthetic C"]) {
      await page.getByLabel("Search tests", { exact: true }).fill(name);
      await page.getByRole("checkbox", { name, exact: true }).check();
    }
    await page
      .getByRole("button", { name: "Remove Synthetic A", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Create order", exact: true })
      .click();
    const collect = page.getByRole("button", { name: "Mark collected" });
    await collect.waitFor();
    assert.equal(await collect.isDisabled(), true);
    assert.equal(
      await page.getByRole("checkbox", { name: "Blood", exact: true }).count(),
      1,
    );
    for (const name of ["Blood", "Urine"]) {
      await page.getByRole("checkbox", { name, exact: true }).click();
      await page
        .getByRole("checkbox", { name, exact: true, checked: true })
        .waitFor();
    }
    if (!interactive) {
      await collect.click();
      await page
        .locator('[aria-current="step"]')
        .filter({ hasText: "Sample collected" })
        .waitFor();
      const { orders } = await post(lab, "/lab", { action: "list" });
      const order = orders.find(
        (item) => item.patientName === "Fictional Walkinexample",
      );
      await post(lab, "/lab", {
        action: "recollect",
        id: order._id,
        revision: order.revision,
        target: order.specimens[0].id,
        reason: "Synthetic recollection",
      });
      await page.getByRole("button", { name: "Back to orders" }).click();
      await page.getByRole("button", { name: "Refresh orders" }).click();
      await page
        .getByLabel("Search orders", { exact: true })
        .fill("Walkinexample");
      await page
        .getByText("Fictional Walkinexample", { exact: false })
        .waitFor();
      await page.screenshot({ path: resolve(artifact, "worklist.png") });
      await page
        .getByRole("button", { name: "LAB-" + order._id, exact: true })
        .click();
      await page
        .getByText("Order details and actions", { exact: true })
        .click();
      await page
        .getByText(/Recollection required.*Synthetic recollection/)
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Cancel order" }).count(),
        0,
      );
    }
  } else {
    if (!recollectedReview) {
      await page
        .getByRole("button", { name: "Catalogue", exact: true })
        .click();
      await page.getByText("Synthetic A · Blood · Approved").waitFor();
      if (!interactive) {
        await page
          .getByLabel("Test name", { exact: true })
          .fill("Fictional validation");
        await page
          .getByLabel("Required specimen", { exact: true })
          .fill("Blood");
        await page.getByLabel(/^Result fields/).fill("Missing separators");
        await page.getByRole("button", { name: "Save catalogue test" }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "Correct line 1" })
          .waitFor();
      }
      await page.getByRole("button", { name: "Back to orders" }).click();
    }
    const { catalogue } = await post(lab, "/lab", { action: "list" });
    let order = await post(reception, "/lab", {
      action: "create",
      patientId: patient.id,
      patientRevision: patient.revision,
      testIds: catalogue.map((test) => test._id),
    });
    for (const row of order.specimens)
      order = await post(reception, "/lab", {
        action: "check",
        id: order._id,
        revision: order.revision,
        target: row.id,
        checked: true,
      });
    order = await post(reception, "/lab", {
      action: "collect",
      id: order._id,
      revision: order.revision,
    });
    if (reportReview) {
      const ordered = order.tests.find((test) => test.name === "Synthetic C");
      order = await post(lab, "/lab", {
        action: "cancel-test",
        id: order._id,
        revision: order.revision,
        target: ordered._id,
        reason: "Fictional cancellation",
      });
      const original = order.tests.find((test) => test.name === "Synthetic A");
      const revised = await post(lab, "/lab", {
        action: "save",
        id: original._id,
        revision: original.revision,
        name: original.name,
        specimen: original.specimen,
        group: original.group,
        fields: [
          {
            name: "Synthetic result revised",
            unit: "demo revised",
            reference: "Synthetic only",
          },
        ],
      });
      await post(lab, "/lab", {
        action: "approve",
        id: revised._id,
        revision: revised.revision,
        reason: "Fictional approved revision",
      });
    }
    if (recollectedReview)
      order = await post(lab, "/lab", {
        action: "recollect",
        id: order._id,
        revision: order.revision,
        target: order.specimens.find((row) => row.kind === "Blood").id,
        reason: "Fictional recollection",
      });
    await page.getByRole("button", { name: "Refresh orders" }).click();
    await page
      .getByRole("button", { name: "LAB-" + order._id, exact: true })
      .click();
    if (reportReview) {
      const latest = async () =>
        (await post(lab, "/lab", { action: "list" })).orders.find(
          (item) => item._id === order._id,
        );
      const call = (user, action, current, extra = {}) =>
        fixture.request("/lab", {
          method: "POST",
          token: user.token,
          body: {
            action,
            id: current._id,
            revision: current.revision,
            ...extra,
          },
        });
      const release = (row, version) => ({
        reportId: version.id,
        patientNumber: row.patientNumber,
        orderNumber: "LAB-" + row._id,
      });
      const waitForEnter = async (message) => {
        console.log(message);
        const terminal = createInterface({ input: process.stdin });
        try {
          await once(terminal, "line");
        } finally {
          terminal.close();
        }
      };
      const readyStep = () =>
        page
          .locator('[aria-current="step"]')
          .filter({ hasText: "Ready to release" });
      async function openAs(account) {
        await page
          .getByRole("button", { name: "Sign out", exact: true })
          .click();
        await signIn(account);
        await page
          .getByRole("button", { name: "LAB-" + order._id, exact: true })
          .click();
      }
      async function enterReleaseIdentifiers() {
        await page
          .getByLabel("Confirm patient number", { exact: true })
          .fill(patient.patientNumber);
        await page
          .getByLabel("Confirm order ID", { exact: true })
          .fill("LAB-" + order._id);
      }
      async function savePdf(label, filename) {
        const path = resolve(pdfDirectory, filename);
        await desktop.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async (_window, options) => {
            const chosenFolder = filePath.slice(0, filePath.lastIndexOf("\\"));
            if (!options.defaultPath.startsWith(chosenFolder + "\\"))
              throw new Error("Expected the isolated PDF export directory.");
            return { canceled: false, filePath };
          };
        }, path);
        await page.getByRole("button", { name: label, exact: true }).click();
        await page
          .getByText("PDF saved.", { exact: true })
          .waitFor({ timeout: 35000 });
        return createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
      if (interactive) {
        await waitForEnter(
          "Enter results, preview and finalize as Lab Admin. Press Enter here when Ready to release.",
        );
        await readyStep().waitFor();
      } else {
        const test = order.tests.find((test) => test.name === "Synthetic A");
        assert.equal(
          (
            await call(reception, "results", order, {
              target: test._id,
              results: ["7"],
            })
          ).status,
          403,
        );
        for (const [name, value] of [
          ["Synthetic A", "7.4"],
          ["Synthetic B", "Normal"],
        ]) {
          await page
            .getByLabel(name + ": Synthetic result (1)", { exact: true })
            .fill(value);
          await page
            .getByRole("button", { name: "Save results: " + name, exact: true })
            .click();
        }
        await page
          .getByRole("button", { name: "Preview report PDF", exact: true })
          .and(page.locator(":enabled"))
          .waitFor();
        const beforeSwitch = await latest();
        const revised = (
          await post(lab, "/lab", { action: "list" })
        ).catalogue.find((item) => item._id === test._id);
        assert.equal(
          (
            await call(lab, "switch-template", beforeSwitch, {
              target: test._id,
              templateRevision: revised.revision,
              reason: "Synthetic method review",
            })
          ).status,
          400,
        );
        await page
          .getByText("Review newer approved template", { exact: true })
          .click();
        await page.getByText("7.4", { exact: true }).waitFor();
        await page
          .getByLabel("Template change reason", { exact: true })
          .fill("Synthetic method review");
        await page
          .getByRole("checkbox", { name: /I reviewed the saved results/ })
          .check();
        await page
          .getByRole("button", {
            name: "Switch approved template",
            exact: true,
          })
          .click();
        const changedField = page.getByLabel(
          "Synthetic A: Synthetic result revised (1)",
          { exact: true },
        );
        await changedField.waitFor();
        assert.equal(await changedField.inputValue(), "");
        assert.deepEqual(
          (await latest()).history.at(-1).previousTemplate.results,
          ["7.4"],
        );
        await changedField.fill("8.1");
        await page
          .getByRole("button", {
            name: "Save results: Synthetic A",
            exact: true,
          })
          .click();
        const previewDigest = await savePdf(
          "Preview report PDF",
          "increment-2-preview.pdf",
        );
        const preview = await latest();
        assert.equal(previewDigest, preview.reportPreview.digest);
        await page
          .getByRole("button", { name: "Finalize report", exact: true })
          .click();
        await readyStep().waitFor();
        const finalized = await latest();
        assert.equal(
          finalized.reportVersions[0].digest,
          preview.reportPreview.digest,
        );
        await page
          .getByLabel("Report action reason", { exact: true })
          .fill("Fictional reopen review");
        await page
          .getByRole("button", { name: "Reopen report", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Results", exact: true })
          .waitFor();
        const reopened = await latest();
        assert.equal(
          (
            await call(
              reception,
              "release-report",
              reopened,
              release(reopened, finalized.reportVersions[0]),
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call(reception, "read-report", reopened, {
              reportId: finalized.reportVersions[0].id,
            })
          ).status,
          409,
        );
        await page
          .getByRole("button", { name: "Preview report PDF", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Finalize report", exact: true })
          .click();
        await readyStep().waitFor();
      }
      await openAs(reception);
      assert.equal(
        await page
          .getByRole("heading", { name: "Results", exact: true })
          .count(),
        0,
      );
      const final = await latest();
      const version = final.reportVersions.at(-1);
      if (interactive) {
        console.log(
          `Reception review · patient ${patient.patientNumber} · order LAB-${order._id}`,
        );
        await waitForEnter(
          "Compare the finalized PDF and release as Reception. Press Enter here once Released.",
        );
        assert.equal((await latest()).status, "Released");
        await openAs(
          await fixture.account({ roles: ["Lab Admin"], mfa: true }),
        );
        await waitForEnter(
          "Withdraw the released version, enter an updated result, preview and finalize the correction. Press Enter when the corrected version is Ready to release.",
        );
        await readyStep().waitFor();
        assert.equal((await latest()).reportVersions.at(-1).corrected, true);
        await openAs(reception);
        console.log(
          `Corrected release review · patient ${patient.patientNumber} · order LAB-${order._id}`,
        );
      } else {
        assert.equal(
          (
            await call(reception, "release-report", final, {
              ...release(final, version),
              patientNumber: "wrong",
            })
          ).status,
          400,
        );
        assert.equal(
          await savePdf("Download current PDF", "increment-2-finalized.pdf"),
          version.digest,
        );
        await enterReleaseIdentifiers();
        await page
          .getByRole("button", { name: "Release report", exact: true })
          .click();
        await page
          .locator('[aria-current="step"]')
          .filter({ hasText: /^Released$/ })
          .waitFor();
        const released = await latest();
        assert.equal(released.reportVersions.at(-1).digest, version.digest);
        const withdrawn = await post(lab, "/lab", {
          action: "withdraw-report",
          id: order._id,
          revision: released.revision,
          reportId: version.id,
          reason: "Fictional withdrawal",
        });
        assert.equal(
          (
            await call(
              reception,
              "release-report",
              withdrawn,
              release(withdrawn, version),
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call(reception, "read-report", withdrawn, {
              reportId: version.id,
            })
          ).status,
          409,
        );
        const corrected = await post(lab, "/lab", {
          action: "preview-report",
          id: order._id,
          revision: withdrawn.revision,
        });
        assert.equal(corrected.order.reportPreview.corrected, true);
        const correction = await post(lab, "/lab", {
          action: "finalize-report",
          id: order._id,
          revision: corrected.order.revision,
          reportId: corrected.order.reportPreview.id,
        });
        const correctedVersion = correction.reportVersions.at(-1);
        assert.equal(
          (
            await call(
              reception,
              "release-report",
              correction,
              release(correction, version),
            )
          ).status,
          409,
        );
        const correctedRelease = await call(
          reception,
          "release-report",
          correction,
          release(correction, correctedVersion),
        );
        assert.equal(correctedRelease.status, 200);
        assert.deepEqual(
          correctedRelease.body.reportVersions.map((row) => row.status),
          ["Reopened", "Withdrawn", "Released"],
        );
      }
    } else if (!interactive && !recollectedReview) {
      await page
        .getByText("Order details and actions", { exact: true })
        .click();
      await page
        .getByLabel("Reason", { exact: true })
        .fill("Fictional recollection");
      await page
        .getByRole("button", {
          name: "Require recollection: Blood",
          exact: true,
        })
        .first()
        .click();
      await page
        .locator('[aria-current="step"]')
        .filter({ hasText: "Registered" })
        .waitFor();
      assert.equal(
        await page.getByRole("checkbox", { checked: true }).count(),
        1,
      );
    }
  }
  await page.screenshot({
    path: resolve(
      artifact,
      actor === reception ? "reception.png" : "lab-admin.png",
    ),
  });
  console.log(
    "PASS: Electron Lab screen connected to the guarded synthetic Staff API.",
  );
  if (interactive) {
    console.log(
      `Synthetic patient number: ${patient.patientNumber}. Press Enter to close and clean up TEST.`,
    );
    const terminal = createInterface({ input: process.stdin });
    try {
      await once(terminal, "line");
    } finally {
      terminal.close();
    }
  }
} finally {
  try {
    await desktop?.close();
    await familyReviewServer?.close();
    if (proxy?.listening) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
    if (fixture) {
      await fixture.reset();
      await fixture.close();
    }
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
