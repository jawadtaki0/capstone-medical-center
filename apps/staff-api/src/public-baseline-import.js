import { BSON } from "mongodb";
import { createHash } from "node:crypto";
import {
  backupDigest,
  PUBLIC_BASELINE_COLLECTIONS,
} from "../../api/src/public-data-backup.js";
import { validateScheduleDay } from "../../api/src/schedule-model.js";
import { PATIENT_LIMIT_RULE } from "../../../shared/session-capacity.mjs";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import {
  validateOperationalRecord,
  assertNoOverlap,
  identifier,
} from "./operational-model.js";
import { validatePublication } from "./operational-publication.js";

export const IMPORT_COLLECTION = "operational_imports";
export const IMPORT_PLAN_VERSION = 2;
const fail = () => {
  throw new Error(
    "Public baseline mapping conflict. Review the source and target before continuing.",
  );
};
const digest = (value) =>
  createHash("sha256").update(BSON.serialize(value)).digest("hex");
function only(value, keys) {
  if (!value || Object.keys(value).some((key) => !keys.includes(key))) fail();
}

export function planPublicBaseline(
  snapshot,
  { clinicId = "clinic:main", clinicName = "Clinic" } = {},
) {
  if (PUBLIC_BASELINE_COLLECTIONS.some((name) => !snapshot.collections[name]))
    fail();
  snapshot = {
    ...snapshot,
    collections: Object.fromEntries(
      PUBLIC_BASELINE_COLLECTIONS.map((name) => [
        name,
        snapshot.collections[name],
      ]),
    ),
  };
  const sourceDigest = backupDigest(snapshot);
  const docs = (name) =>
    snapshot.collections[name].raw.map((raw) => BSON.deserialize(raw));
  const weekly = docs("weekly_schedules");
  if (
    weekly.length !== 1 ||
    weekly[0].effectiveFrom !== null ||
    weekly[0].publicationStatus !== "published"
  )
    fail();
  const baseline = weekly[0];
  only(baseline, [
    "_id",
    "days",
    "effectiveFrom",
    "publicationStatus",
    "publishedAt",
  ]);
  if (
    !baseline.days ||
    Object.keys(baseline.days).length !== 7 ||
    Object.keys(baseline.days).some((day) => !/^[0-6]$/.test(day))
  )
    fail();
  const records = {
    scopes: [
      validateOperationalRecord("scopes", {
        id: clinicId,
        name: clinicName,
        kind: "clinic",
        active: true,
      }),
    ],
    professionals: [],
    sessions: [],
    exceptions: [],
    hours: [],
  };
  for (const [name, kind] of [
    ["doctor_profiles", "doctor"],
    ["specialist_profiles", "specialist"],
  ]) {
    for (const p of docs(name)) {
      only(p, ["_id", "name", "specialty", "active", "gender"]);
      if (!["male", "female"].includes(p.gender)) fail();
      records.professionals.push(
        validateOperationalRecord("professionals", {
          id: p._id,
          kind,
          name: p.name,
          specialty: p.specialty,
          active: p.active,
          gender: p.gender,
          scopeIds: [clinicId],
        }),
      );
    }
  }
  const profiles = new Map(records.professionals.map((p) => [p.id, p]));
  if (profiles.size !== records.professionals.length) fail();
  const sourceMap = [];
  function convertDay(day, weekday, where) {
    only(day, [
      "closed",
      "centerHours",
      "doctorSessions",
      "specialistSessions",
      "otherServices",
    ]);
    if (day.centerHours) only(day.centerHours, ["startTime", "endTime"]);
    validateScheduleDay(day);
    const sessions = [];
    for (const [group, reference] of [
      ["doctorSessions", "doctorId"],
      ["specialistSessions", "specialistId"],
    ])
      for (const s of day[group]) {
        only(s, [
          "id",
          reference,
          "startTime",
          "endTime",
          "status",
          "appointmentRequired",
          "capacity",
        ]);
        const p = profiles.get(s[reference]);
        if (!p || (s.status === "active" && !p.active)) fail();
        const capacity = s.capacity === undefined ? null : s.capacity;
        sessions.push(
          validateOperationalRecord("sessions", {
            id: s.id,
            scopeId: clinicId,
            professionalId: p.id,
            weekday,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            appointmentRequired: s.appointmentRequired,
            capacity,
          }),
        );
        sourceMap.push({ source: `${where}:${s.id}`, target: s.id });
      }
    for (const s of day.otherServices) {
      only(s, ["id", "name", "startTime", "endTime", "status"]);
      const existing = records.scopes.find((scope) => scope.id === s.id);
      if (existing && (existing.kind !== "service" || existing.name !== s.name))
        fail();
      if (!existing)
        records.scopes.push(
          validateOperationalRecord("scopes", {
            id: s.id,
            name: s.name,
            kind: "service",
            active: true,
          }),
        );
      const id = identifier(`${weekday}:${s.id}`);
      sessions.push(
        validateOperationalRecord("sessions", {
          id,
          scopeId: s.id,
          professionalId: null,
          weekday,
          startTime: s.startTime,
          endTime: s.endTime,
          status: s.status,
          appointmentRequired: false,
          capacity: null,
        }),
      );
      sourceMap.push({ source: `${where}:${s.id}`, target: id });
    }
    return sessions;
  }
  for (let weekday = 0; weekday < 7; weekday++) {
    const day = baseline.days?.[weekday];
    records.hours.push(
      validateOperationalRecord("hours", {
        id: String(weekday),
        closed: day?.closed,
        ...(day?.closed ? {} : day?.centerHours),
      }),
    );
    records.sessions.push(
      ...convertDay(day, weekday, `${baseline._id}:${weekday}`),
    );
  }
  for (const change of docs("schedule_date_changes")) {
    only(change, [
      "_id",
      "weeklyScheduleId",
      "date",
      "publicationStatus",
      "publishedAt",
      "day",
    ]);
    if (
      change.weeklyScheduleId !== baseline._id ||
      change.publicationStatus !== "published"
    )
      fail();
    const weekday = new Date(`${change.date}T12:00:00Z`).getUTCDay();
    const sessions = convertDay(change.day, weekday, change._id);
    records.hours.push(
      validateOperationalRecord("hours", {
        id: change.date,
        closed: change.day.closed,
        ...(change.day.closed ? {} : change.day.centerHours),
      }),
    );
    for (const scope of records.scopes)
      records.exceptions.push(
        validateOperationalRecord("exceptions", {
          id: scope.id === clinicId ? change._id : `${change._id}:${scope.id}`,
          scopeId: scope.id,
          date: change.date,
          closed: change.day.closed,
          sessions: sessions.filter((s) => s.scopeId === scope.id),
        }),
      );
  }
  assertNoOverlap(records.sessions, records.exceptions);
  validatePublication(records);
  const collections = {
    operational_scopes: records.scopes,
    doctor_profile_drafts: records.professionals.filter(
      (p) => p.kind === "doctor",
    ),
    specialist_profile_drafts: records.professionals.filter(
      (p) => p.kind === "specialist",
    ),
    operational_session_drafts: records.sessions,
    operational_date_drafts: records.exceptions,
    operational_hours_drafts: records.hours,
  };
  for (const values of Object.values(collections))
    if (new Set(values.map((v) => v.id)).size !== values.length) fail();
  const plan = {
    version: IMPORT_PLAN_VERSION,
    sourceDigest,
    capacityRule: PATIENT_LIMIT_RULE,
    effectiveFrom: null,
    lineage: {
      weeklyScheduleId: baseline._id,
      publishedAt: baseline.publishedAt,
      sourceMap,
    },
    collections,
  };
  return { ...plan, digest: digest(plan) };
}

export async function applyPublicBaseline({
  db,
  client,
  snapshot,
  expectedDigest,
  expectedRevision = 0,
  demoMode,
  environment = { mode: "test" },
  failBeforeCommit = async () => {},
}) {
  assertPublicationStorage(db, client, demoMode, "staff", environment);
  const plan = planPublicBaseline(snapshot);
  if (plan.digest !== expectedDigest)
    throw new Error(
      "Import plan changed or uses a superseded rule. Regenerate the plan and repeat reconciliation.",
    );
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        const guard = await db
          .collection("staff_management_state")
          .updateOne(
            { _id: "staff-controls" },
            { $inc: { revision: 1 } },
            { session },
          );
        if (guard.matchedCount !== 1)
          throw new Error(
            "Existing staff authority is required; no bootstrap is performed.",
          );
        const ledger = db.collection(IMPORT_COLLECTION),
          old = await ledger.findOne(
            { _id: "public-baseline-v1" },
            { session },
          );
        if (old) {
          if (
            old.planVersion !== IMPORT_PLAN_VERSION ||
            old.capacityRule !== PATIENT_LIMIT_RULE ||
            old.digest !== plan.digest
          )
            throw new Error(
              "A different or formula-era baseline was already imported. Preserve its history and reconcile before continuing.",
            );
          return {
            status: old.rolledBackAt
              ? "already_rolled_back"
              : "already_imported",
            digest: plan.digest,
          };
        }
        const state = await db
          .collection("operational_state")
          .findOne({ _id: "working" }, { session });
        if (
          (state?.revision ?? 0) !== expectedRevision ||
          (state?.head ?? 0) !== 0
        )
          throw new Error("Target revision/publication conflict.");
        for (const name of [
          ...Object.keys(plan.collections),
          "operational_grants",
          "operational_publications",
          "public_publication_outbox",
        ])
          if (await db.collection(name).findOne({}, { session }))
            throw new Error(
              "Target contains existing operational work. Reconcile; nothing was overwritten.",
            );
        for (const [name, values] of Object.entries(plan.collections))
          if (values.length)
            await db.collection(name).insertMany(
              values.map((value) => ({ _id: value.id, ...value, revision: 1 })),
              { session },
            );
        await db
          .collection("operational_state")
          .updateOne(
            { _id: "working" },
            { $set: { revision: expectedRevision + 1, head: 0 } },
            { session, upsert: true },
          );
        await ledger.insertOne(
          {
            _id: "public-baseline-v1",
            planVersion: IMPORT_PLAN_VERSION,
            digest: plan.digest,
            sourceDigest: plan.sourceDigest,
            capacityRule: plan.capacityRule,
            lineage: plan.lineage,
            completedAt: new Date(),
            importedIds: Object.fromEntries(
              Object.entries(plan.collections).map(([name, values]) => [
                name,
                values.map((v) => v.id),
              ]),
            ),
          },
          { session },
        );
        await failBeforeCommit();
        return { status: "imported", digest: plan.digest };
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      },
    );
  } finally {
    await session.endSession();
  }
}

export async function undoPublicBaseline({
  db,
  client,
  snapshot,
  expectedDigest,
  demoMode,
  environment = { mode: "test" },
}) {
  assertPublicationStorage(db, client, demoMode, "staff", environment);
  const plan = planPublicBaseline(snapshot);
  if (plan.digest !== expectedDigest) fail();
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        const guard = await db
          .collection("staff_management_state")
          .updateOne(
            { _id: "staff-controls" },
            { $inc: { revision: 1 } },
            { session },
          );
        if (guard.matchedCount !== 1) fail();
        const ledger = await db
          .collection(IMPORT_COLLECTION)
          .findOne({ _id: "public-baseline-v1" }, { session });
        if (!ledger || ledger.digest !== plan.digest) fail();
        if (ledger.rolledBackAt) return { status: "already_rolled_back" };
        const state = await db
          .collection("operational_state")
          .findOne({ _id: "working" }, { session });
        if (state?.head !== 0 || state?.revision !== 1)
          throw new Error(
            "Import has subsequent work/publications. Reconcile; rollback refused.",
          );
        for (const name of [
          "operational_grants",
          "operational_publications",
          "public_publication_outbox",
        ])
          if (await db.collection(name).findOne({}, { session })) fail();
        for (const [name, values] of Object.entries(plan.collections)) {
          const actual = await db
            .collection(name)
            .find({}, { session })
            .toArray();
          if (
            actual.length !== values.length ||
            values.some(
              (v) =>
                !actual.some(
                  (a) =>
                    a._id === v.id &&
                    digest(a) === digest({ _id: v.id, ...v, revision: 1 }),
                ),
            )
          )
            throw new Error(
              "Imported records changed. Rollback refused; no work was removed.",
            );
        }
        for (const [name, values] of Object.entries(plan.collections))
          if (values.length)
            await db
              .collection(name)
              .deleteMany(
                { _id: { $in: values.map((v) => v.id) } },
                { session },
              );
        await db
          .collection("operational_state")
          .updateOne(
            { _id: "working" },
            { $set: { revision: 0, head: 0, publicationPaused: true } },
            { session },
          );
        await db
          .collection(IMPORT_COLLECTION)
          .updateOne(
            { _id: ledger._id },
            { $set: { rolledBackAt: new Date() } },
            { session },
          );
        return { status: "rolled_back", digest: plan.digest };
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
  } finally {
    await session.endSession();
  }
}

export async function setPublicationPause({
  db,
  client,
  expectedHead,
  paused,
}) {
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        const guarded = await db
          .collection("staff_management_state")
          .updateOne(
            { _id: "staff-controls" },
            { $inc: { revision: 1 } },
            { session },
          );
        if (guarded.matchedCount !== 1) fail();
        const result = await db
          .collection("operational_state")
          .updateOne(
            { _id: "working", head: expectedHead },
            { $set: { publicationPaused: paused } },
            { session },
          );
        if (result.matchedCount !== 1)
          throw new Error(
            "Publication head changed. No transition was performed.",
          );
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
  } finally {
    await session.endSession();
  }
}
