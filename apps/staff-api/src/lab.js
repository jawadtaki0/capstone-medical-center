import { createHash, randomUUID } from "node:crypto";
import { StaffError } from "./errors.js";
import { renderLabPdf } from "./lab-pdf.js";
import { hasLabCollection } from "../../staff/shared/lab-collection.js";
import { labNotice, labMessage } from "../../staff/shared/lab-notice.js";
import { canonicalPhone } from "../../staff/shared/contact-input.js";

const allowed = ["Admin", "Lab Admin", "Receptionist"];
export function labExportFilename(order, version, corrected) {
  const patient = order.patientName
    ?.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const name = Array.from(patient || "patient").slice(0, 70).join("");
  return `${name}-results-${order._id.slice(0, 8)}-v${version}${corrected ? "-corrected" : ""}.pdf`;
}
const fail = (message, status = 400) => {
  throw new StaffError("lab_action", message, status);
};
const clean = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 250)
    fail("Enter the required Lab details.");
  return value.trim();
};

export function createLabService({
  db,
  transaction,
  guard,
  authenticated,
  now,
  hostedLab,
}) {
  const catalogue = db.collection("lab_catalogue");
  const orders = db.collection("lab_orders");
  const reports = db.collection("lab_reports");
  return async (token, input) => {
    const result = await transaction(async (session) => {
      const { action, id, revision } = input ?? {};
      const at = now();
      if (action !== "list") await guard(session);
      const auth = await authenticated(session, token, at);
      if (auth.failure) return auth;
      const roles = auth.account.roles;
      const lab = roles.includes("Lab Admin");
      const reception = roles.includes("Receptionist");
      const manage = lab || roles.includes("Admin");
      const canRelease = reception || manage;
      const requireRole = (can) => {
        if (!can) fail("This Lab action is not permitted.", 403);
      };
      requireRole(roles.some((role) => allowed.includes(role)));
      const options = { session };
      if (action === "list")
        return {
          catalogue: await catalogue
            .find({}, options)
            .sort({ name: 1 })
            .limit(500)
            .toArray(),
          orders: await orders
            .find({}, options)
            .sort({ createdAt: -1 })
            .limit(100)
            .toArray(),
        };
      if (["save", "retire", "approve"].includes(action)) {
        requireRole(action === "approve" ? lab : manage);
        const previous =
          typeof id === "string"
            ? await catalogue.findOne({ _id: id }, options)
            : null;
        if (
          (id && (!previous || revision !== previous.revision)) ||
          (!previous && action !== "save")
        )
          fail("Reload the catalogue entry.", 409);
        let entry;
        if (action === "save") {
          if (
            !Array.isArray(input.fields) ||
            !input.fields.length ||
            input.fields.length > 30
          )
            fail("Enter at least one result field.");
          entry = {
            _id: previous?._id ?? randomUUID(),
            revision: (previous?.revision ?? 0) + 1,
            name: clean(input.name),
            specimen: clean(input.specimen),
            group: input.group ? clean(input.group) : "",
            fields: input.fields.map((field) => ({
              name: clean(field?.name),
              unit: clean(field?.unit),
              reference: clean(field?.reference),
            })),
            active: true,
            approval: null,
          };
        } else {
          entry = { ...previous, revision: previous.revision + 1 };
          if (action === "retire") entry.active = false;
          else {
            if (!entry.active) fail("Retired tests cannot be approved.");
            entry.approval = {
              at,
              actor: auth.account._id,
              evidence: clean(input.reason),
            };
          }
        }
        if (previous)
          await catalogue.replaceOne(
            { _id: entry._id, revision },
            entry,
            options,
          );
        else await catalogue.insertOne(entry, options);
        return entry;
      }
      if (action === "create") {
        requireRole(reception || lab);
        const patient = await db
          .collection("patients")
          .findOne({ _id: clean(input.patientId) }, options);
        if (!patient || patient.revision !== input.patientRevision)
          fail("Select the current patient record again.", 409);
        const ids = input.testIds;
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 30 ||
          ids.some((value) => typeof value !== "string") ||
          new Set(ids).size !== ids.length
        )
          fail("Choose active tests.");
        const tests = await catalogue
          .find(
            { _id: { $in: ids }, active: true, approval: { $ne: null } },
            options,
          )
          .toArray();
        if (tests.length !== ids.length)
          fail("Choose active tests with approved templates.");
        const specimens = [];
        for (const test of tests) {
          let row =
            test.group &&
            specimens.find(
              (item) =>
                item.group === test.group && item.kind === test.specimen,
            );
          if (!row) {
            row = {
              id: randomUUID(),
              group: test.group,
              kind: test.specimen,
              testIds: [],
              checked: false,
            };
            specimens.push(row);
          }
          row.testIds.push(test._id);
        }
        const order = {
          _id: randomUUID(),
          revision: 1,
          patientId: patient._id,
          patientNumber: patient.patientNumber,
          patientName: [patient.firstName, patient.lastName].join(" "),
          createdAt: at,
          status: "Registered",
          tests,
          specimens,
          history: [],
        };
        await orders.insertOne(order, options);
        return order;
      }
      if (typeof id !== "string") fail("Select a Lab order.");
      const order = await orders.findOne({ _id: id }, options);
      if (!order || order.revision !== revision)
        fail("Reload the Lab order.", 409);
      if (action === "publish-release" || action === "retry-release-email") {
        requireRole(canRelease);
        if (
          !hostedLab ||
          order.status !== "Released" ||
          !order.reportVersions.at(-1)?.websitePublication
        )
          fail("Only a released report can be published.", 409);
        return { orderToPublish: order };
      }
      if (
        [
          "open-notice",
          "delivery-contact",
          "mark-notice-sent",
          "contact-pending",
          "contact-confirm",
        ].includes(action)
      ) {
        requireRole(reception || lab);
        const patient = await db
          .collection("patients")
          .findOne({ _id: order.patientId }, options);
        if (!patient) fail("The patient record is unavailable.", 404);
        const source = patient;
        const accounts = db.collection("patient_accounts");
        if (
          hostedLab &&
          source.websiteAccountId &&
          action.startsWith("contact-")
        )
          fail(
            "Change the website account number through Cedar phone verification.",
            409,
          );
        const account =
          source.websiteAccountId &&
          (hostedLab
            ? await hostedLab({
                action: "contact",
                accountId: source.websiteAccountId,
                profileId: source.verifiedWebsiteProfileId ?? source._id,
              }).catch(() => {
                fail(
                  "The verified website contact could not be checked. Try again.",
                  503,
                );
              })
            : await accounts.findOne(
                {
                  _id: source.websiteAccountId,
                  profiles: {
                    $elemMatch: {
                      id: source.verifiedWebsiteProfileId ?? source._id,
                      revokedAt: { $exists: false },
                    },
                  },
                },
                options,
              ));
        const pending = account
          ? account.labPendingContact ||
            (account.pendingPhone !== account.verifiedWhatsAppPhone &&
              account.pendingPhone)
          : patient.labPendingContact;
        const recipient = source?.websiteAccountId
          ? account?.verifiedWhatsAppPhone
          : canonicalPhone(patient.labVerifiedPhone || patient.phone);
        const needsConfirmation = !source.websiteAccountId && !patient.labVerifiedPhone;
        if (action === "delivery-contact")
          return { phone: recipient ?? null, onHold: Boolean(pending), needsConfirmation };
        let draft;
        if (action.startsWith("contact-")) {
          if (source?.websiteAccountId && !account)
            fail(
              "Confirm the current patient account before changing the delivery contact.",
              409,
            );
          const phone = canonicalPhone(input.phone);
          if (!phone) fail("Enter a valid WhatsApp number.");
          const confirm = action === "contact-confirm";
          if (confirm && (input.confirmed !== true || pending !== phone))
            fail("Confirm possession of the pending number first.");
          if (account) {
            const update = confirm
              ? {
                  $set: { verifiedWhatsAppPhone: phone, pendingPhone: phone },
                  $unset: {
                    labPendingContact: "",
                    verifiedPersonalPhone: "",
                    phoneCheck: "",
                  },
                  $inc: { revision: 1 },
                }
              : { $set: { labPendingContact: phone }, $inc: { revision: 1 } };
            await accounts.updateOne({ _id: account._id }, update, options);
            if (confirm)
              await db
                .collection("patients")
                .updateMany(
                  { websiteAccountId: account._id },
                  { $set: { phone }, $inc: { revision: 1 } },
                  options,
                );
          } else {
            await db.collection("patients").updateOne(
              { _id: patient._id },
              confirm
                ? {
                    $set: { labVerifiedPhone: phone, phone },
                    $unset: { labPendingContact: "" },
                    $inc: { revision: 1 },
                  }
                : { $set: { labPendingContact: phone }, $inc: { revision: 1 } },
              options,
            );
          }
          order.history.push({ action, at, actor: auth.account._id });
        } else {
          const notice = labNotice(order);
          if (
            !notice ||
            notice.id !== input.noticeId ||
            order.noticeDelivery?.[notice.id]?.sentAt
          )
            fail("This notice is no longer pending. Refresh the order.", 409);
          if (pending || !recipient)
            fail(
              "Delivery is on hold until the intended WhatsApp contact is verified.",
              409,
            );
          order.noticeDelivery ??= {};
          if (action === "mark-notice-sent") {
            const prepared = order.noticeDelivery[notice.id];
            if (!prepared || prepared.phone !== recipient)
              fail(
                "Open the current draft to the verified contact first.",
                409,
              );
            order.noticeDelivery[notice.id] = {
              ...prepared,
              sentAt: at,
              sentBy: auth.account._id,
            };
          } else {
            if (needsConfirmation && input.confirmed !== true)
              fail("Confirm the registered number belongs to the intended recipient.", 409);
            if (!["en", "ar", "both"].includes(input.language))
              fail("Choose a supported message language.");
            const name = [
              patient.firstName,
              patient.fatherName,
              patient.lastName,
            ]
              .filter(Boolean)
              .join(" ");
            draft = {
              phone: recipient,
              message: (input.language === "both" ? ["en", "ar"] : [input.language])
                .map((language) => labMessage(notice.kind, language, name, "LAB-" + id))
                .join("\n\n"),
            };
            if (notice.report) {
              const stored = await reports.findOne(
                { _id: notice.report.id, orderId: id },
                options,
              );
              if (
                !stored ||
                createHash("sha256")
                  .update(Buffer.from(stored.pdf, "base64"))
                  .digest("hex") !== notice.report.digest
              )
                fail("The released PDF could not be verified.", 409);
              draft.pdf = stored.pdf;
              draft.filename = labExportFilename(order, notice.report.version, notice.report.corrected);
            }
            order.noticeDelivery[notice.id] = {
              phone: recipient,
              openedAt: at,
              openedBy: auth.account._id,
              language: input.language,
            };
          }
        }
        order.revision++;
        if (
          !(await orders.replaceOne({ _id: id, revision }, order, options))
            .matchedCount
        )
          fail("Reload the Lab order.", 409);
        return draft
          ? {
              order,
              message: draft.message,
              phone: draft.phone,
              ...(draft.pdf
                ? { pdf: draft.pdf, filename: draft.filename }
                : {}),
            }
          : order;
      }
      const reportAction = [
        "results",
        "switch-template",
        "preview-report",
        "read-report",
        "finalize-report",
        "release-report",
        "reopen-report",
        "withdraw-report",
      ].includes(action);
      if (
        !reportAction &&
        !["Registered", "Sample collected"].includes(order.status)
      )
        fail("This order is closed.", 409);
      let reason, target, previousTemplate, previousResults, draft;
      const required = order.specimens.filter((row) =>
        row.testIds.some((testId) =>
          order.tests.some((test) => test._id === testId && !test.cancelled),
        ),
      );
      if (reportAction) {
        const versions = (order.reportVersions ??= []);
        const current = versions.at(-1);
        const requireState = (condition, message) => {
          if (!condition) fail(message, 409);
        };
        if (action === "read-report") {
          const preview = order.reportPreview;
          const readableDraft =
            lab &&
            preview &&
            preview.id === input.reportId &&
            preview.revision === order.revision;
          const readableFinal =
            current?.id === input.reportId &&
            ["Ready to release", "Released"].includes(order.status) &&
            ["Finalized", "Released"].includes(current.status);
          requireState(
            readableDraft || readableFinal,
            "This PDF is no longer available.",
          );
          const stored = await reports.findOne(
            { _id: input.reportId, orderId: id },
            options,
          );
          requireState(stored, "This PDF is no longer available.");
          const selected = readableDraft ? preview : current;
          return {
            pdf: stored.pdf,
            digest: stored.digest,
            filename: labExportFilename(
              order,
              selected.version,
              selected.corrected,
            ),
          };
        }
        if (action === "release-report") {
          requireRole(canRelease);
          requireState(
            order.status === "Ready to release" &&
              current?.status === "Finalized" &&
              current.id === input.reportId,
            "Only the current finalized report can be released.",
          );
          if (
            input.patientNumber !== order.patientNumber ||
            input.orderNumber !== "LAB-" + id
          )
            fail(
              "Confirm the exact patient number and order ID shown on the report.",
            );
          const stored = await reports.findOne(
            { _id: current.id, orderId: id, digest: current.digest },
            options,
          );
          requireState(
            stored &&
              createHash("sha256")
                .update(Buffer.from(stored.pdf, "base64"))
                .digest("hex") === current.digest,
            "The finalized PDF could not be verified.",
          );
          current.status = "Released";
          if (hostedLab) {
            const linked = await db
              .collection("patients")
              .findOne({ _id: order.patientId }, options);
            if (linked?.websiteAccountId)
              current.websitePublication = {
                accountId: linked.websiteAccountId,
                profileId: linked.verifiedWebsiteProfileId ?? linked._id,
              };
          }
          order.status = "Released";
          target = current.id;
        } else if (action === "reopen-report" || action === "withdraw-report") {
          const reopening = action === "reopen-report";
          requireRole(reopening ? lab : manage);
          requireState(
            current?.id === input.reportId &&
              current?.status === (reopening ? "Finalized" : "Released") &&
              order.status === (reopening ? "Ready to release" : "Released"),
            "Select the current report version.",
          );
          reason = clean(input.reason);
          if (!reopening && current.websitePublication) {
            const revoked = await hostedLab?.({
              action: "withdraw",
              reportId: current.id,
            }).catch(() => null);
            if (!revoked?.withdrawn)
              fail(
                "Website withdrawal could not be confirmed. Retry withdrawal.",
                503,
              );
          }
          current.status = reopening ? "Reopened" : "Withdrawn";
          current.reason = reason;
          order.status = "Sample collected";
          target = current.id;
        } else {
          requireRole(lab);
          requireState(
            order.status === "Sample collected",
            "Collect all required specimens before preparing a report.",
          );
          if (action === "results" || action === "switch-template") {
            const test = order.tests.find(
              (item) => item._id === input.target && !item.cancelled,
            );
            if (!test) fail("Select an ordered test that was not cancelled.");
            target = test._id;
            if (action === "results") {
              if (
                !Array.isArray(input.results) ||
                input.results.length !== test.fields.length
              )
                fail("Enter a result for every approved field in this test.");
              test.results = input.results.map(clean);
            } else {
              reason = clean(input.reason);
              if (input.reviewed !== true)
                fail(
                  "Confirm that you reviewed the old results, fields and units against the new template and verified the method.",
                );
              const newer = await catalogue.findOne(
                {
                  _id: test._id,
                  active: true,
                  revision: input.templateRevision,
                },
                options,
              );
              requireState(
                newer?.approval &&
                  newer.revision > test.revision &&
                  newer.specimen === test.specimen &&
                  newer.group === test.group,
                "Choose a newer approved template for the same specimen configuration.",
              );
              previousTemplate = {
                revision: test.revision,
                fields: test.fields,
                results: test.results,
                approval: test.approval,
              };
              Object.assign(test, newer, { results: [] });
            }
          } else if (action === "preview-report") {
            if (
              required.some((row) => !row.checked) ||
              !order.tests.some((test) => !test.cancelled) ||
              order.tests.some(
                (test) =>
                  !test.cancelled &&
                  test.results?.length !== test.fields.length,
              )
            )
              fail(
                "Save results for every active test before previewing the PDF.",
              );
            const patient = await db
              .collection("patients")
              .findOne({ _id: order.patientId }, options);
            requireState(patient, "The patient record is unavailable.");
            const corrected = versions.some(
              (version) => version.status === "Withdrawn",
            );
            const version = versions.length + 1;
            let bytes;
            try {
              bytes = await renderLabPdf(
                order,
                patient,
                at,
                corrected,
                version,
              );
            } catch {
              fail(
                "The PDF could not be generated. Check that Microsoft Edge is available and try again.",
                503,
              );
            }
            if (bytes.length > 4_000_000)
              fail("The report exceeds the PDF size limit.", 413);
            target = randomUUID();
            const digest = createHash("sha256").update(bytes).digest("hex");
            const filename = `LAB-${id}-v${version}${corrected ? "-corrected" : ""}.pdf`;
            if (order.reportPreview)
              await reports.deleteOne(
                { _id: order.reportPreview.id, orderId: id },
                options,
              );
            await reports.insertOne(
              {
                _id: target,
                orderId: id,
                pdf: bytes.toString("base64"),
                digest,
                filename,
              },
              options,
            );
            order.reportPreview = {
              id: target,
              revision: revision + 1,
              digest,
              filename,
              corrected,
              version,
            };
            draft = {
              pdf: bytes.toString("base64"),
              filename: labExportFilename(order, version, corrected),
            };
          } else {
            const preview = order.reportPreview;
            requireState(
              preview?.revision === revision && preview.id === input.reportId,
              "Preview the current results first.",
            );
            const stored = await reports.findOne(
              { _id: preview.id, orderId: id, digest: preview.digest },
              options,
            );
            requireState(stored, "The preview PDF is unavailable.");
            const { revision: ignoredRevision, ...identity } = preview;
            versions.push({
              ...identity,
              status: "Finalized",
              finalizedAt: at,
            });
            delete order.reportPreview;
            order.status = "Ready to release";
            target = preview.id;
          }
        }
      } else if (action === "check" || action === "recollect") {
        requireRole(action === "recollect" ? lab : reception || lab);
        if (action === "check" && order.status !== "Registered")
          fail("This sample is already collected.");
        if (action === "recollect" && order.status !== "Sample collected")
          fail("Collect the sample first.");
        const row = required.find((item) => item.id === input.target);
        if (!row) fail("Select a required specimen.");
        target = row.id;
        if (action === "recollect") {
          reason = clean(input.reason);
          row.checked = false;
          previousResults = order.tests
            .filter(
              (test) => row.testIds.includes(test._id) && test.results?.length,
            )
            .map((test) => {
              const snapshot = {
                testId: test._id,
                templateRevision: test.revision,
                values: test.results,
              };
              delete test.results;
              return snapshot;
            });
          order.status = "Registered";
        } else {
          if (typeof input.checked !== "boolean")
            fail("Select a specimen check.");
          row.checked = input.checked;
        }
      } else if (action === "collect") {
        requireRole(lab || reception);
        if (
          order.status !== "Registered" ||
          !required.length ||
          required.some((row) => !row.checked)
        )
          fail("Check every required specimen before marking collected.");
        order.status = "Sample collected";
      } else if (action === "cancel" || action === "cancel-test") {
        requireRole(
          lab ||
            (action === "cancel" &&
              reception &&
              order.status === "Registered" &&
              !hasLabCollection(order)),
        );
        reason = clean(input.reason);
        if (action === "cancel-test") {
          const test = order.tests.find(
            (item) => item._id === input.target && !item.cancelled,
          );
          if (!test) fail("Select an active test.");
          test.cancelled = true;
          target = test._id;
        }
        if (action === "cancel" || order.tests.every((test) => test.cancelled))
          order.status = "Cancelled";
      } else fail("Unknown Lab action.");
      order.history.push({
        action,
        at,
        actor: auth.account._id,
        status: order.status,
        reason,
        target,
        checked: action === "check" ? input.checked : undefined,
        ...(previousTemplate ? { previousTemplate } : {}),
        ...(previousResults?.length ? { previousResults } : {}),
      });
      order.revision++;
      const result = await orders.replaceOne(
        { _id: id, revision },
        order,
        options,
      );
      if (!result.matchedCount) fail("Reload the Lab order.", 409);
      return draft ? { order, ...draft } : order;
    });
    if (
      !hostedLab ||
      (input?.action !== "release-report" && !result?.orderToPublish) ||
      result?.failure
    )
      return result;
    const order = result.orderToPublish ?? result;
    const current = order.reportVersions.at(-1);
    if (!current.websitePublication) return order;
    async function saveEmailStatus(emailStatus) {
      if (!["failed", "sent", "skipped", "unconfirmed"].includes(emailStatus))
        return order;
      await orders.updateOne(
        {
          _id: order._id,
          status: "Released",
          reportVersions: {
            $elemMatch: {
              id: current.id,
              status: "Released",
              websiteEmailStatus:
                emailStatus === "failed"
                  ? { $nin: ["failed", "sent", "skipped", "unconfirmed"] }
                  : { $ne: emailStatus },
            },
          },
        },
        {
          $set: { "reportVersions.$.websiteEmailStatus": emailStatus },
          $inc: { revision: 1 },
        },
      );
      return await orders.findOne({ _id: order._id }) ?? order;
    }
    if (input.action === "retry-release-email") {
      const outcome = await hostedLab({
        action: "retry-release-email",
        reportId: current.id,
      }).catch(() => null);
      if (!outcome?.released)
        fail("Report email status could not be refreshed. The report remains released.", 503);
      return saveEmailStatus(outcome.emailStatus);
    }
    const stored = await reports.findOne({
      _id: current.id,
      orderId: order._id,
    });
    const published =
      stored &&
      (await hostedLab({
        action: "release",
        reportId: current.id,
        ...current.websitePublication,
        digest: current.digest,
        pdf: stored.pdf,
        filename: stored.filename,
        orderNumber: "LAB-" + order._id,
        date: current.finalizedAt.toISOString(),
        corrected: current.corrected === true,
      }).catch(() => null));
    if (!published?.released)
      fail(
        "The report was released locally. Reload the order and retry website publication.",
        503,
      );
    return saveEmailStatus(published.emailStatus);
  };
}
