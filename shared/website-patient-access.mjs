import { createHash } from "node:crypto";
import {
  PATIENT_FIELDS,
  nameKey,
  patientNameSignatures,
} from "../apps/staff/shared/patient-input.js";

const uuid = /^[a-f0-9-]{36}$/i;
const refuse = (status, message) => {
  throw Object.assign(new Error(message), { code: "family_access", status });
};
const missing = () => refuse(404, "No report was found for this profile.");

export function createWebsitePatientAccess({ db }) {
  const patients = db.collection("patients");
  const orders = db.collection("lab_orders");
  const reports = db.collection("lab_reports");
  async function exactPatient(accountId, profileId, session) {
    const candidates = await patients
      .find(
        {
          websiteAccountId: accountId,
          $or: [
            { _id: profileId, verifiedWebsiteProfileId: { $exists: false } },
            { verifiedWebsiteProfileId: profileId },
          ],
        },
        { session, projection: { _id: 1 } },
      )
      .limit(2)
      .toArray();
    if (candidates.length > 1)
      refuse(409, "The verified patient connection is ambiguous.");
    return candidates[0];
  }

  async function sync(accountId, profiles, at, session) {
    for (const profile of profiles) {
      if (await exactPatient(accountId, profile.id, session)) continue;
      const counter = await db
        .collection("patient_registry_state")
        .findOneAndUpdate(
          { _id: "registry" },
          { $inc: { lastNumber: 1, revision: 1 } },
          { session, upsert: true, returnDocument: "after" },
        );
      if (!Number.isSafeInteger(counter?.lastNumber))
        refuse(503, "Patient numbering is unavailable.");
      await patients.insertOne(
        {
          _id: profile.id,
          websiteAccountId: accountId,
          ...Object.fromEntries(
            PATIENT_FIELDS.map((key) => [key, profile[key]]),
          ),
          patientNumber: "P-" + String(counter.lastNumber).padStart(8, "0"),
          revision: 1,
          updatedAt: at,
          updatedBy: "website",
          keys: Object.fromEntries(
            PATIENT_FIELDS.slice(0, 4).map((key) => [
              key,
              nameKey(profile[key]),
            ]),
          ),
          firstSignatures: patientNameSignatures(profile.firstName),
          lastSignatures: patientNameSignatures(profile.lastName),
        },
        { session },
      );
    }
  }
  async function targets(account, id) {
    if (
      !account.emailVerifiedAt ||
      !account.verifiedWhatsAppPhone ||
      typeof id !== "string" ||
      !uuid.test(id) ||
      !account.profiles?.some(
        (profile) => profile.id === id && !profile.revokedAt,
      )
    )
      missing();
    const profile = await exactPatient(account._id, id);
    if (!profile) missing();
    return [profile._id];
  }
  const profiles = (account) =>
    (account.profiles ?? [])
      .filter((profile) => !profile.revokedAt)
      .map((profile) => ({
        id: profile.id,
        name: [profile.firstName, profile.lastName].join(" "),
      }));
  async function list(account, id) {
    const patientIds = await targets(account, id);
    const released = await orders
      .find({ patientId: { $in: patientIds }, status: "Released" })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return released.flatMap((order) => {
      const report = order.reportVersions?.at(-1);
      return report?.status === "Released"
        ? [
            {
              id: report.id,
              orderNumber: "LAB-" + order._id,
              date: report.finalizedAt,
              corrected: report.corrected,
            },
          ]
        : [];
    });
  }
  async function download(account, id, reportId) {
    const patientIds = await targets(account, id);
    if (typeof reportId !== "string" || !uuid.test(reportId)) missing();
    const report = await reports.findOne({ _id: reportId });
    if (!report) missing();
    const order = await orders.findOne({
      _id: report.orderId,
      patientId: { $in: patientIds },
      status: "Released",
    });
    const version = order?.reportVersions?.at(-1);
    if (
      version?.id !== reportId ||
      version.status !== "Released" ||
      version.digest !== report.digest
    )
      missing();
    const bytes = Buffer.from(report.pdf, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== version.digest)
      missing();
    return { bytes, filename: report.filename };
  }
  return { sync, profiles, list, download };
}
