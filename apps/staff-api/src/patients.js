import { createHash, randomUUID } from "node:crypto";
import { StaffError } from "./errors.js";
import {
  PATIENT_FIELDS,
  PATIENT_ROLES,
  patientInput,
  patientToday,
  nameKey,
  patientNameSignatures,
  classifyPatientDuplicate,
  realPatientDate,
  shiftPatientYear,
} from "../../staff/shared/patient-input.js";
import { validRoles } from "../../../shared/staff-roles.mjs";
import { canonicalPhone } from "../../staff/shared/contact-input.js";

const bad = () =>
  new StaffError(
    "patient_input",
    "Check the required patient fields and search criteria.",
  );
const stale = () =>
  new StaffError(
    "patient_stale",
    "This patient record changed. Reload it before editing again.",
    409,
  );
const projection = Object.fromEntries(
  ["_id", "patientNumber", "revision", ...PATIENT_FIELDS].map((k) => [k, 1]),
);
const dto = (p) => ({
  id: p._id,
  patientNumber: p.patientNumber,
  revision: p.revision,
  ...Object.fromEntries(PATIENT_FIELDS.map((k) => [k, p[k]])),
});
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw bad();
}
function id(value) {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    throw bad();
  return value;
}

export async function ensurePatientIndexes(db) {
  const patients = db.collection("patients");
  await patients.createIndex({ patientNumber: 1 }, { unique: true });
  for (const field of [
    "firstName",
    "fatherName",
    "lastName",
    "motherFirstName",
  ])
    await patients.createIndex({ [`keys.${field}`]: 1, patientNumber: 1 });
  await patients.createIndex({ dateOfBirth: 1, patientNumber: 1 });
  await patients.createIndex({ phone: 1, patientNumber: 1 });
  await patients.createIndex({ firstSignatures: 1, dateOfBirth: 1 });
  await patients.createIndex({ firstSignatures: 1, "keys.motherFirstName": 1 });
  await db
    .collection("patient_changes")
    .createIndex({ patientId: 1, occurredAt: -1 });
}

export function createPatientService({
  db,
  transaction,
  guard,
  authenticated,
  now,
}) {
  const patients = db.collection("patients"),
    state = db.collection("patient_registry_state");
  async function actor(session, token, at) {
    const auth = await authenticated(session, token, at);
    if (auth.failure) return auth;
    if (
      !validRoles(auth.account.roles) ||
      !auth.account.roles.some((r) => PATIENT_ROLES.includes(r))
    )
      throw new StaffError(
        "forbidden",
        "Patient registry access is not permitted.",
        403,
      );
    return auth;
  }
  function recordFrom(input, at) {
    fields(input, PATIENT_FIELDS);
    const checked = patientInput(input, patientToday(at));
    if (Object.keys(checked.errors).length) throw bad();
    return checked.record;
  }
  async function existing(input, session) {
    if (input.patientId === undefined) return null;
    id(input.patientId);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      throw bad();
    const p = await patients.findOne({ _id: input.patientId }, { session });
    if (!p)
      throw new StaffError("patient_missing", "Patient record not found.", 404);
    if (p.revision !== input.expectedRevision) throw stale();
    return p;
  }
  async function review(record, target, revision, session) {
    // Indexed deletion signatures are a conservative superset; final classification
    // compares every name separately. A bounded overflow is never reported as clear.
    const low = shiftPatientYear(record.dateOfBirth, -1),
      high = shiftPatientYear(record.dateOfBirth, 1);
    const matches = await patients
      .find(
        {
          ...(target ? { _id: { $ne: target._id } } : {}),
          firstSignatures: { $in: patientNameSignatures(record.firstName) },
          lastSignatures: { $in: patientNameSignatures(record.lastName) },
          $or: [
            { dateOfBirth: { $gte: low, $lte: high } },
            { "keys.motherFirstName": nameKey(record.motherFirstName) },
          ],
        },
        { session, projection },
      )
      .sort({ patientNumber: 1 })
      .limit(51)
      .maxTimeMS(2000)
      .toArray();
    const hasMore = matches.length > 50;
    const candidates = matches
      .slice(0, 50)
      .flatMap((p) => {
        const classification = classifyPatientDuplicate(record, p);
        return classification
          ? [
              {
                ...dto(p),
                classification,
                phoneMatch: p.phone === record.phone,
                ...(p.dateOfBirth !== record.dateOfBirth
                  ? {
                      dateDiscrepancy: {
                        entered: record.dateOfBirth,
                        existing: p.dateOfBirth,
                      },
                    }
                  : {}),
              },
            ]
          : [];
      })
      .sort(
        (a, b) =>
          (a.classification === b.classification
            ? 0
            : a.classification === "strong"
              ? -1
              : 1) || a.patientNumber.localeCompare(b.patientNumber),
      );
    const reviewDigest = createHash("sha256")
      .update(
        JSON.stringify({
          record,
          target: target ? { id: target._id, revision: target.revision } : null,
          revision,
          candidates,
          hasMore,
        }),
      )
      .digest("hex");
    return { reviewDigest, candidates, hasMore };
  }
  const allowedSave = [
    "record",
    "patientId",
    "expectedRevision",
    "reviewDigest",
    "duplicateOverride",
  ];
  async function save(token, input, updating) {
    return transaction(async (session) => {
      const at = now();
      await guard(session);
      const auth = await actor(session, token, at);
      if (auth.failure) return auth;
      fields(input, allowedSave);
      if (
        updating !== Boolean(input.patientId) ||
        (!updating && input.expectedRevision !== undefined)
      )
        throw bad();
      const record = recordFrom(input.record, at),
        target = await existing(input, session);
      if (input.duplicateOverride !== undefined) {
        fields(input.duplicateOverride, ["acknowledged", "reason"]);
        if (
          input.duplicateOverride.acknowledged !== true ||
          typeof input.duplicateOverride.reason !== "string" ||
          !input.duplicateOverride.reason.trim() ||
          input.duplicateOverride.reason.length > 500
        )
          throw bad();
      }
      // Every create/edit participates in the same write guard. A retried concurrent
      // transaction sees a new revision and must return a fresh duplicate review.
      const prior = await state.findOneAndUpdate(
        { _id: "registry" },
        { $inc: { serial: 1 }, $setOnInsert: { lastNumber: 0, revision: 0 } },
        { session, upsert: true, returnDocument: "before" },
      );
      // Missing/corrupt numbering state must never silently restart allocation
      // against existing records. Reconciliation is an operator task, not repair
      // performed by a registration request.
      if (
        (prior &&
          (!Number.isSafeInteger(prior.lastNumber) ||
            prior.lastNumber < 0 ||
            !Number.isSafeInteger(prior.revision) ||
            prior.revision < 0)) ||
        (!prior &&
          (await patients.findOne({}, { session, projection: { _id: 1 } })))
      ) {
        throw new StaffError(
          "patient_numbers_unavailable",
          "Patient numbering requires reconciliation. No patient was saved.",
          503,
        );
      }
      const checked = await review(
        record,
        target,
        prior?.revision ?? 0,
        session,
      );
      if (
        input.reviewDigest !== checked.reviewDigest ||
        ((checked.candidates.length || checked.hasMore) &&
          !input.duplicateOverride)
      )
        return { reviewRequired: true, ...checked };
      let number = target?.patientNumber;
      if (!target) {
        const counter = await state.findOneAndUpdate(
          { _id: "registry", lastNumber: { $lt: Number.MAX_SAFE_INTEGER } },
          { $inc: { lastNumber: 1 } },
          { session, returnDocument: "after" },
        );
        if (!counter || !Number.isSafeInteger(counter.lastNumber))
          throw new StaffError(
            "patient_numbers_unavailable",
            "Patient numbering is unavailable. No patient was saved.",
            503,
          );
        number = `P-${String(counter.lastNumber).padStart(8, "0")}`;
      }
      const patientId = target?._id ?? randomUUID(),
        changes = {};
      for (const field of PATIENT_FIELDS)
        if (!target || target[field] !== record[field])
          changes[field] = {
            before: target?.[field] ?? null,
            after: record[field],
          };
      const saved = {
        ...record,
        patientNumber: number,
        revision: (target?.revision ?? 0) + 1,
        keys: Object.fromEntries(
          PATIENT_FIELDS.slice(0, 4).map((k) => [k, nameKey(record[k])]),
        ),
        firstSignatures: patientNameSignatures(record.firstName),
        lastSignatures: patientNameSignatures(record.lastName),
        updatedAt: at,
        updatedBy: auth.account._id,
      };
      if (target) {
        const changed = await patients.updateOne(
          { _id: patientId, revision: target.revision },
          { $set: saved },
          { session },
        );
        if (changed.modifiedCount !== 1) throw stale();
      } else
        await patients.insertOne(
          {
            _id: patientId,
            ...saved,
            createdAt: at,
            createdBy: auth.account._id,
          },
          { session },
        );
      const action = target ? "update" : "create";
      await state.updateOne(
        { _id: "registry" },
        { $inc: { revision: 1 } },
        { session },
      );
      await db.collection("patient_changes").insertOne(
        {
          _id: randomUUID(),
          patientId,
          actorId: auth.account._id,
          action,
          occurredAt: at,
          revision: saved.revision,
          changes,
          ...(checked.candidates.length || checked.hasMore
            ? {
                duplicateReview: {
                  reason: input.duplicateOverride.reason.trim(),
                  candidates: checked.candidates.map((p) => ({
                    id: p.id,
                    revision: p.revision,
                    classification: p.classification,
                  })),
                  hasMore: checked.hasMore,
                },
              }
            : {}),
        },
        { session },
      );
      // Ordinary security events contain identifiers/field names, never patient values.
      await db.collection("security_events").insertOne(
        {
          _id: randomUUID(),
          actorId: auth.account._id,
          targetId: patientId,
          action: `patient_${action}`,
          occurredAt: at,
          outcome: "success",
          fields: Object.keys(changes),
        },
        { session },
      );
      return { patient: dto({ _id: patientId, ...saved }) };
    });
  }
  return {
    create: (token, input) => save(token, input, false),
    update: (token, input) => save(token, input, true),
    check: (token, input) =>
      transaction(async (session) => {
        const at = now(),
          auth = await actor(session, token, at);
        if (auth.failure) return auth;
        fields(input, ["record", "patientId", "expectedRevision"]);
        if (
          input.patientId === undefined &&
          input.expectedRevision !== undefined
        )
          throw bad();
        const record = recordFrom(input.record, at),
          target = await existing(input, session),
          current = await state.findOne({ _id: "registry" }, { session });
        return review(record, target, current?.revision ?? 0, session);
      }),
    read: (token, input) =>
      transaction(async (session) => {
        const auth = await actor(session, token, now());
        if (auth.failure) return auth;
        fields(input, ["patientId"]);
        const p = await patients.findOne(
          { _id: id(input.patientId) },
          { session, projection },
        );
        if (!p)
          throw new StaffError(
            "patient_missing",
            "Patient record not found.",
            404,
          );
        return { patient: dto(p) };
      }),
    search: (token, input) =>
      transaction(async (session) => {
        const auth = await actor(session, token, now());
        if (auth.failure) return auth;
        const names = PATIENT_FIELDS.slice(0, 4);
        fields(input, [
          ...names,
          "dateOfBirth",
          "phone",
          "patientNumber",
          "cursor",
        ]);
        if (
          Object.values(input).some(
            (value) => typeof value !== "string" || value.length > 80,
          )
        )
          throw bad();
        const query = {};
        for (const field of names) {
          if (input[field] === undefined || input[field] === "") continue;
          if (typeof input[field] !== "string" || input[field].length > 80)
            throw bad();
          const key = nameKey(input[field]);
          if (Array.from(key).length < 2) throw bad();
          query[`keys.${field}`] = { $gte: key, $lt: `${key}\uffff` };
        }
        if (input.dateOfBirth) {
          if (!realPatientDate(input.dateOfBirth)) throw bad();
          query.dateOfBirth = input.dateOfBirth;
        }
        if (input.phone) {
          const phone = canonicalPhone(input.phone, "LB");
          if (!phone) throw bad();
          query.phone = phone;
        }
        if (input.patientNumber) {
          if (
            typeof input.patientNumber !== "string" ||
            !/^P-\d{8,16}$/.test(input.patientNumber)
          )
            throw bad();
          query.patientNumber = input.patientNumber;
        }
        if (!Object.keys(query).length) throw bad();
        if (input.cursor !== undefined) {
          if (
            typeof input.cursor !== "string" ||
            !/^P-\d{8,16}$/.test(input.cursor)
          )
            throw bad();
          if (query.patientNumber) throw bad();
          query.patientNumber = { $gt: input.cursor };
        }
        const found = await patients
          .find(query, { session, projection })
          .sort({ patientNumber: 1 })
          .limit(21)
          .maxTimeMS(2000)
          .toArray();
        return {
          patients: found.slice(0, 20).map(dto),
          nextCursor: found.length > 20 ? found[19].patientNumber : null,
        };
      }),
  };
}
