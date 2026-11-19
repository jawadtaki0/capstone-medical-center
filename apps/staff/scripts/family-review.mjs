import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { createApp } from "../../api/src/app.js";
import {
  patientAccountRouter,
  ensurePatientAccountIndexes,
} from "../../api/src/patient-accounts.js";
import { createWebsitePatientAccess } from "../../../shared/website-patient-access.mjs";
import { labNotice } from "../shared/lab-notice.js";
import { patientToday, shiftPatientYear } from "../shared/patient-input.js";
const origin = "http://127.0.0.1:5211";
const password = "Fictional review " + randomUUID();
const phone = "+12025550142";
export async function startFamilyReview({
  fixture,
  reception,
  lab,
  patient,
  post,
  interactive,
  noticeScenario,
}) {
  assert.equal(fixture.db.databaseName, "capstone_staff_test");
  await ensurePatientAccountIndexes(fixture.db);
  let activation;
  const app = createApp({
    clientOrigin: origin,
    websiteDirectory: resolve(".local/lab-family-review/web"),
    scheduleReader: async () => [],
    professionalsReader: async () => [],
    patientAccounts: patientAccountRouter({
      db: fixture.db,
      client: fixture.client,
      publicOrigin: origin,
      clock: fixture.clock,
      familyAccess: createWebsitePatientAccess({ db: fixture.db }),
      deliver(message) {
        activation = message;
      },
    }),
  });
  const server = app.listen(5211, "127.0.0.1");
  await once(server, "listening");
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  async function call(action, body, cookie, status = 200) {
    const response = await fetch(origin + "/api/patient-account/" + action, {
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      method: "POST",
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return {
      result,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function register(username, firstName, contact) {
    const email = username + "@example.invalid";
    const record = {
      firstName,
      lastName: "Reviewfamily",
      fatherName: "Fictional",
      motherFirstName: "Example",
      dateOfBirth: "1981-04-02",
      gender: "female",
      phone: contact,
    };
    await call("signup", {
      email,
      relationship: "self",
      patient: record,
      language: "en",
    });
    const token = new URLSearchParams(
      new URL(activation.link).hash.slice(1),
    ).get("token");
    await call("activate", { token, username, password });
    await fixture.db
      .collection("patient_accounts")
      .updateOne({ email }, { $set: { verifiedWhatsAppPhone: contact } });
    return {
      email,
      ...(await call("signin", { identifier: email, password })),
    };
  }
  try {
    const mother = await register("review.mother", "Mother", phone);
    const other = await register("review.other", "Other", "+12025550143");
    const child = {
      creationKey: randomUUID(),
      profiles: [
        {
          relationship: "child",
          patient: {
            firstName: "Child",
            lastName: "Reviewfamily",
            fatherName: "Fictional",
            motherFirstName: "Mother",
            dateOfBirth: interactive
              ? "2017-04-02"
              : shiftPatientYear(
                  patientToday(new Date(+fixture.clock() + 86400000)),
                  -18,
                ),
            gender: "female",
          },
        },
      ],
    };
    if (!interactive) await call("add-profiles", child, mother.cookie);
    if (!interactive) await call("add-profiles", child, mother.cookie);
    const adultId = mother.result.account.profiles[0].id;
    const staff = (route, body) => post(reception, route, body);
    const { catalogue } = await post(lab, "/lab", { action: "list" });
    let order = await staff("/lab", {
      action: "create",
      patientId: patient.id,
      patientRevision: patient.revision,
      testIds: [catalogue[0]._id],
    });
    const change = (actor, action, extra = {}) =>
      post(actor, "/lab", {
        action,
        id: order._id,
        revision: order.revision,
        ...extra,
      });
    order = await change(reception, "check", {
      target: order.specimens[0].id,
      checked: true,
    });
    order = await change(reception, "collect");
    order = await change(lab, "results", {
      target: catalogue[0]._id,
      results: ["Fictional result"],
    });
    const preview = await change(lab, "preview-report");
    order = preview.order;
    order = await change(lab, "finalize-report", {
      reportId: order.reportPreview.id,
    });
    const version = order.reportVersions.at(-1);
    order = await change(reception, "release-report", {
      reportId: version.id,
      patientNumber: patient.patientNumber,
      orderNumber: "LAB-" + order._id,
    });
    async function reuseTrustedFixture() {
      const accounts = fixture.db.collection("patient_accounts");
      const registry = fixture.db.collection("patients");
      const owner = await accounts.findOne({ email: mother.email });
      const session = fixture.client.startSession();
      try {
        await session.withTransaction(async () => {
          // Model an earlier verified pair already present in Cedar, never a Staff action.
          const removed = await registry.deleteOne(
            { _id: adultId, websiteAccountId: owner._id, updatedBy: "website" },
            { session },
          );
          assert.equal(removed.deletedCount, 1);
          await registry.updateOne(
            { _id: patient.id },
            {
              $set: {
                websiteAccountId: owner._id,
                verifiedWebsiteProfileId: adultId,
                phone,
              },
            },
            { session },
          );
          await createWebsitePatientAccess({ db: fixture.db }).sync(
            owner._id,
            [owner.profiles[0]],
            fixture.clock(),
            session,
          );
          assert.equal(
            await registry.countDocuments({ _id: adultId }, { session }),
            0,
          );
          assert.equal(
            (await registry.findOne({ _id: patient.id }, { session }))
              .patientNumber,
            patient.patientNumber,
          );
        });
      } finally {
        await session.endSession();
      }
    }
    if (
      interactive &&
      !noticeScenario &&
      process.argv.includes("--trusted-record")
    )
      await reuseTrustedFixture();
    if (noticeScenario) {
      if (noticeScenario === "cancellation") {
        order = await staff("/lab", {
          action: "create",
          patientId: patient.id,
          patientRevision: patient.revision,
          testIds: [catalogue[0]._id],
        });
        order = await change(reception, "cancel", {
          reason: "Fictional cancellation",
        });
      } else if (noticeScenario !== "release") {
        order = await change(lab, "withdraw-report", {
          reportId: version.id,
          reason: "Fictional withdrawal",
        });
        if (noticeScenario === "recollection") {
          order = await change(lab, "recollect", {
            target: order.specimens[0].id,
            reason: "Fictional recollection",
          });
        } else if (noticeScenario === "corrected") {
          const corrected = await change(lab, "preview-report");
          order = corrected.order;
          order = await change(lab, "finalize-report", {
            reportId: order.reportPreview.id,
          });
          order = await change(reception, "release-report", {
            reportId: order.reportVersions.at(-1).id,
            patientNumber: patient.patientNumber,
            orderNumber: "LAB-" + order._id,
          });
        }
      }
      order = await change(reception, "contact-pending", { phone });
      order = await change(reception, "contact-confirm", {
        phone,
        confirmed: true,
      });
      assert.equal(labNotice(order).kind, noticeScenario);
      console.log(
        "Fictional " +
          noticeScenario +
          " notice · LAB-" +
          order._id +
          " · contact " +
          phone,
      );
    } else if (interactive)
      console.log(
        "Website: " +
          origin +
          "/account | " +
          mother.email +
          " | password: " +
          password +
          " | search " +
          phone +
          " | existing report record: " +
          patient.patientNumber,
      );
    return {
      close,
      orderId: order._id,
      verify: async (page, desktop) => {
        if (interactive) return;
        const { patients } = await staff("/patients/search", { phone });
        const same = patients.filter((row) => row.lastName === "Reviewfamily");
        assert.equal(same.length, 2);
        assert.equal(new Set(same.map((row) => row.id)).size, 2);
        assert.equal(
          await fixture.db.collection("bookings").countDocuments(),
          0,
        );
        await page
          .getByRole("button", { name: "Patients", exact: true })
          .click();
        await page
          .getByLabel("Phone number", { exact: true })
          .fill("+1 202 555 0142");
        await page
          .getByRole("button", { name: "Search patients", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Mother Reviewfamily", exact: true })
          .waitFor();
        await page
          .getByRole("heading", { name: "Child Reviewfamily", exact: true })
          .waitFor();
        for (const name of ["Mother Reviewfamily", "Child Reviewfamily"]) {
          const row = page
            .locator(".patient-results > li")
            .filter({ has: page.getByRole("heading", { name, exact: true }) });
          assert.deepEqual(await row.getByRole("button").allTextContents(), [
            "Open patient",
          ]);
        }
        const url =
          origin +
          "/api/patient-account/lab-report/" +
          adultId +
          "/" +
          version.id;
        const download = (cookie) =>
          fetch(url, { headers: { Cookie: cookie } });
        assert.equal((await download(mother.cookie)).status, 404);
        await fixture.db
          .collection("patients")
          .updateOne(
            { _id: adultId },
            { $set: { matchedPatientId: patient.id } },
          );
        assert.equal((await download(mother.cookie)).status, 404);
        await reuseTrustedFixture();
        const pdf = await download(mother.cookie);
        assert.equal(pdf.status, 200);
        assert.equal(
          createHash("sha256")
            .update(Buffer.from(await pdf.arrayBuffer()))
            .digest("hex"),
          version.digest,
        );
        assert.equal((await download(other.cookie)).status, 404);
        const browser = await chromium.launch({ channel: "msedge" });
        try {
          const portal = await browser.newPage();
          await portal.goto(origin + "/account");
          await portal.getByLabel(/Email, username/).fill(mother.email);
          await portal.locator('input[name="password"]').fill(password);
          await portal.getByRole("button", { name: /^sign in$/i }).click();
          await portal
            .getByRole("button", { name: "Lab results", exact: true })
            .click();
          await portal
            .getByRole("tab", { name: "Mother Reviewfamily" })
            .click();
          assert.equal(
            await portal
              .getByRole("link", { name: "Download PDF" })
              .getAttribute("href"),
            new URL(url).pathname,
          );
          await portal.getByRole("tab", { name: "Child Reviewfamily" }).click();
          await portal
            .getByText("No released reports for this patient.")
            .waitFor();
        } finally {
          await browser.close();
        }
        await page.getByRole("button", { name: "Lab", exact: true }).click();
        await page
          .getByRole("button", { name: "LAB-" + order._id, exact: true })
          .click();
        await page.getByText("WhatsApp delivery", { exact: true }).click();
        const attachment = resolve(
          "Lab PDFs",
          "fictional-whatsapp-attachment.pdf",
        );
        await desktop.evaluate(({ dialog }, path) => {
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: path,
          });
        }, attachment);
        await page.getByRole("button", { name: "Open WhatsApp draft" }).click();
        await page.getByText("PDF saved.", { exact: true }).waitFor();
        assert.equal(
          createHash("sha256")
            .update(await readFile(attachment))
            .digest("hex"),
          version.digest,
        );
        order = (await post(lab, "/lab", { action: "list" })).orders.find(
          (item) => item._id === order._id,
        );
        const noticeRequest = (action, extra) =>
          fixture.request("/lab", {
            method: "POST",
            token: reception.token,
            body: { action, id: order._id, revision: order.revision, ...extra },
          });
        async function checkDrafts(kind, digest) {
          for (const language of ["en", "ar"]) {
            const notice = labNotice(order);
            assert.equal(notice.kind, kind);
            const draft = await change(reception, "open-notice", {
              noticeId: notice.id,
              language,
            });
            order = draft.order;
            assert.ok(
              draft.message.includes("Synthetic Father Labreview") &&
                draft.message.includes("LAB-" + order._id),
            );
            assert.ok(
              draft.message.includes(
                language === "ar" ? "مركز سيدر الطبي" : "Cedar",
              ),
            );
            assert.equal(Boolean(draft.pdf), Boolean(digest));
            assert.equal(
              Boolean(order.noticeDelivery[notice.id].sentAt),
              false,
            );
            if (digest) {
              assert.match(
                draft.message,
                /https:\/\/cedar-cmc\.vercel\.app\/account/,
              );
              assert.equal(
                createHash("sha256")
                  .update(Buffer.from(draft.pdf, "base64"))
                  .digest("hex"),
                digest,
              );
            }
          }
        }
        const oldNotice = labNotice(order).id;
        await checkDrafts("release", version.digest);
        order = await change(reception, "contact-pending", {
          phone: "+12025550146",
        });
        assert.equal(
          (await noticeRequest("mark-notice-sent", { noticeId: oldNotice }))
            .status,
          409,
        );
        assert.equal(
          (
            await noticeRequest("open-notice", {
              noticeId: oldNotice,
              language: "en",
            })
          ).status,
          409,
        );
        assert.equal((await download(mother.cookie)).status, 200);
        order = await change(reception, "contact-confirm", {
          phone: "+12025550146",
          confirmed: true,
        });
        assert.equal(
          (
            await staff("/patients/search", { phone: "+12025550146" })
          ).patients.filter(
            (row) =>
              row.websiteProfile ||
              row.patientNumber === patient.patientNumber ||
              row.lastName === "Reviewfamily",
          ).length,
          2,
        );
        await checkDrafts("release", version.digest);
        order = await change(reception, "mark-notice-sent", {
          noticeId: oldNotice,
        });
        assert.ok(
          order.noticeDelivery[oldNotice].sentAt &&
            order.noticeDelivery[oldNotice].sentBy,
        );
        order = await change(lab, "withdraw-report", {
          reportId: version.id,
          reason: "Fictional withdrawal",
        });
        assert.equal((await download(mother.cookie)).status, 404);
        assert.equal(
          (
            await noticeRequest("open-notice", {
              noticeId: oldNotice,
              language: "en",
            })
          ).status,
          409,
        );
        await checkDrafts("withdrawal");
        const corrected = await change(lab, "preview-report");
        order = corrected.order;
        order = await change(lab, "finalize-report", {
          reportId: order.reportPreview.id,
        });
        const correction = order.reportVersions.at(-1);
        order = await change(reception, "release-report", {
          reportId: correction.id,
          patientNumber: patient.patientNumber,
          orderNumber: "LAB-" + order._id,
        });
        await checkDrafts("corrected", correction.digest);
        const legacy = (
          await staff("/patients/read", { patientId: patient.id })
        ).patient;
        order = await staff("/lab", {
          action: "create",
          patientId: legacy.id,
          patientRevision: legacy.revision,
          testIds: [catalogue[0]._id],
        });
        order = await change(reception, "check", {
          target: order.specimens[0].id,
          checked: true,
        });
        order = await change(reception, "collect");
        order = await change(lab, "recollect", {
          target: order.specimens[0].id,
          reason: "Fictional recollection",
        });
        await checkDrafts("recollection");
        order = await change(lab, "cancel", {
          reason: "Fictional cancellation",
        });
        await checkDrafts("cancellation");
        await page
          .getByRole("button", { name: "Back to orders", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Refresh orders", exact: true })
          .click();
        await page
          .getByRole("button", { name: "LAB-" + order._id, exact: true })
          .click();
        await page.getByText("WhatsApp delivery", { exact: true }).click();
        await page.getByRole("button", { name: "Open WhatsApp draft" }).click();
        await page.getByText(/Draft prepared for/).waitFor();
        await page.getByRole("button", { name: "Mark sent" }).click();
        await page.getByText("Cancellation · Sent", { exact: true }).waitFor();
        fixture.advance(26 * 60 * 60 * 1000);
        const aged = await call("signin", {
          identifier: mother.email,
          password,
        });
        const visible = await call("family-profiles", {}, aged.cookie);
        assert.deepEqual(
          visible.result.profiles.map((profile) => profile.name),
          ["Mother Reviewfamily", "Child Reviewfamily"],
        );
        console.log(
          "PASS: exact profile sync and trusted reuse, report permissions, all five bilingual notices, exact attachments, replacement hold and intercepted Staff Mark sent.",
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
