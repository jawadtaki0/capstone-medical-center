import { createHash } from "node:crypto";
import { exact } from "../../../shared/website-request-contract.mjs";
import { requestCrypto } from "../../../shared/website-request-security.mjs";
import { PATIENT_FIELDS, nameKey } from "../../staff/shared/patient-input.js";

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unavailable = () =>
  Object.assign(new Error("Lab report is unavailable."), {
    code: "family_access",
    status: 404,
  });

export function createHostedLab({ db, key }) {
  const crypto = requestCrypto(key);
  const accounts = db.collection("patient_accounts");
  const reports = db.collection("hosted_lab_reports");
  const profiles = db.collection("hosted_lab_profiles");
  const context = ({ _id, accountId, profileId, digest }) =>
    JSON.stringify(["cedar-lab-v1", _id, accountId, profileId, digest]);
  const active = (account, profileId) =>
    id.test(profileId ?? "") &&
    account?.profiles?.some((p) => p.id === profileId && !p.revokedAt);
  const authorized = (account, profileId) =>
    account?.emailVerifiedAt &&
    account.verifiedWhatsAppPhone &&
    active(account, profileId);

  return {
    async sync(accountId, saved, _at, session) {
      // A collection bulk write re-applies the client timeout inside the
      // hosted transaction. Individual upserts use the transaction deadline.
      for (const profile of saved) {
        await profiles.updateOne(
          { _id: profile.id, accountId },
          {
            $setOnInsert: {
              accountId,
              patient: Object.fromEntries(
                PATIENT_FIELDS.map((field) => [field, profile[field]]),
              ),
              keys: Object.fromEntries(
                PATIENT_FIELDS.slice(0, 4).map((field) => [
                  field,
                  nameKey(profile[field]),
                ]),
              ),
            },
          },
          { upsert: true, session },
        );
      }
    },
    async pruneProfiles(accountId, session) {
      await profiles.deleteMany({ accountId }, { session });
    },
    profiles(account) {
      return (account.profiles ?? [])
        .filter((p) => !p.revokedAt)
        .map((p) => ({ id: p.id, name: [p.firstName, p.lastName].join(" ") }));
    },
    async list(account, profileId) {
      if (!authorized(account, profileId)) throw unavailable();
      return reports
        .find(
          { accountId: account._id, profileId, state: "released" },
          {
            projection: {
              _id: 0,
              id: "$_id",
              orderNumber: 1,
              date: 1,
              corrected: 1,
            },
          },
        )
        .sort({ date: -1 })
        .limit(100)
        .toArray();
    },
    async download(account, profileId, reportId) {
      if (!authorized(account, profileId) || !id.test(reportId ?? ""))
        throw unavailable();
      const report = await reports.findOne({
        _id: reportId,
        accountId: account._id,
        profileId,
        state: "released",
      });
      if (!report) throw unavailable();
      const bytes = Buffer.from(
        crypto.open(report.sealed, context(report)),
        "base64",
      );
      if (digest(bytes) !== report.digest) throw unavailable();
      return { bytes, filename: report.filename };
    },
    async staff(input) {
      if (input?.action === "contact") {
        exact(input, ["action", "accountId", "profileId"]);
        if (
          ![input.accountId, input.profileId].every(
            (value) => typeof value === "string" && id.test(value),
          )
        )
          throw unavailable();
        const account = await accounts.findOne({ _id: input.accountId });
        if (!active(account, input.profileId)) throw unavailable();
        return {
          pendingPhone: account.pendingPhone ?? null,
          verifiedWhatsAppPhone: account.verifiedWhatsAppPhone ?? null,
        };
      }
      if (input?.action === "profiles") {
        exact(input, ["action", "criteria", "after"]);
        const names = PATIENT_FIELDS.slice(0, 4);
        exact(input.criteria, [...names, "phone", "dateOfBirth"], []);
        const query = {};
        for (const [field, value] of Object.entries(input.criteria)) {
          if (typeof value !== "string" || !value || value.length > 80)
            throw unavailable();
          if (names.includes(field)) {
            const key = nameKey(value);
            if (Array.from(key).length < 2) throw unavailable();
            query["keys." + field] = { $gte: key, $lt: key + "\uffff" };
          } else query["patient." + field] = value;
        }
        if (!Object.keys(query).length) throw unavailable();
        if (input.after !== null) {
          if (typeof input.after !== "string" || !id.test(input.after))
            throw unavailable();
          query._id = { $gt: input.after };
        }
        const rows = await profiles
          .find(query, { projection: { keys: 0 } })
          .sort({ _id: 1 })
          .limit(101)
          .maxTimeMS(2000)
          .toArray();
        return {
          profiles: rows.slice(0, 100),
          after: rows.length > 100 ? rows[99]._id : null,
        };
      }
      if (input?.action === "withdraw") {
        exact(input, ["action", "reportId"]);
        if (!id.test(input.reportId ?? "")) throw unavailable();
        // Replace any ciphertext with a durable tombstone. Delayed release
        // requests for this version cannot restore it.
        await reports.replaceOne(
          { _id: input.reportId },
          { _id: input.reportId, state: "withdrawn" },
          { upsert: true, writeConcern: { w: "majority" } },
        );
        return { withdrawn: true };
      }
      if (input?.action !== "release") throw unavailable();
      exact(input, [
        "action",
        "reportId",
        "accountId",
        "profileId",
        "digest",
        "pdf",
        "filename",
        "orderNumber",
        "date",
        "corrected",
      ]);
      const {
        reportId,
        accountId,
        profileId,
        filename,
        orderNumber,
        date,
        corrected,
        pdf,
      } = input;
      if (
        ![reportId, accountId, profileId].every(
          (value) => typeof value === "string" && id.test(value),
        ) ||
        typeof orderNumber !== "string" ||
        !orderNumber.startsWith("LAB-") ||
        !id.test(orderNumber.slice(4)) ||
        typeof filename !== "string" ||
        !filename.startsWith(orderNumber + "-v") ||
        !/^\d+(?:-corrected)?\.pdf$/.test(
          filename.slice(orderNumber.length + 2),
        ) ||
        typeof date !== "string" ||
        !Number.isFinite(Date.parse(date)) ||
        typeof corrected !== "boolean" ||
        typeof pdf !== "string" ||
        pdf.length > 5_333_336
      )
        throw unavailable();
      const account = await accounts.findOne({ _id: accountId });
      if (!active(account, profileId)) throw unavailable();
      const bytes = Buffer.from(pdf, "base64");
      if (
        bytes.length > 4_000_000 ||
        bytes.toString("base64") !== pdf ||
        bytes.subarray(0, 5).toString() !== "%PDF-" ||
        digest(bytes) !== input.digest
      )
        throw unavailable();
      const record = {
        _id: reportId,
        accountId,
        profileId,
        filename,
        orderNumber,
        date: new Date(date),
        corrected,
        digest: input.digest,
        state: "released",
      };
      record.sealed = crypto.seal(pdf, context(record));
      await reports.updateOne(
        { _id: reportId },
        { $setOnInsert: record },
        { upsert: true, writeConcern: { w: "majority" } },
      );
      const stored = await reports.findOne({ _id: reportId });
      if (stored?.state === "withdrawn") return { withdrawn: true };
      if (!stored || context(stored) !== context(record)) throw unavailable();
      return { released: true };
    },
  };
}
