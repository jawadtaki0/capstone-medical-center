import { BSON } from "mongodb";
import { COLLECTIONS, validateScheduleDay } from "./schedule-model.js";

export const DEVELOPMENT_DATABASE = "medical-center-dev";
export const LEGACY_ARCHIVE_COLLECTION = "public_schedule_days";
export const SCHEMA_COLLECTIONS = Object.freeze(Object.values(COLLECTIONS));
export const BACKUP_COLLECTIONS = Object.freeze([...SCHEMA_COLLECTIONS, LEGACY_ARCHIVE_COLLECTION]);

// Owner-confirmed identities, used only to migrate existing records. Runtime
// avatars use stored gender, not this map. The existing Makahhel ID is retained.
export const CONFIRMED_GENDERS = Object.freeze({
  "doctor:hasan-ezzeddine": "male",
  "doctor:issam-al-tawil": "male",
  "doctor:hasan-rahal": "male",
  "doctor:hasan-abou-zaid": "male",
  "doctor:ghazi-sarghani": "male",
  "doctor:hussein-saad": "male",
  "doctor:mohammad-rizk": "male",
  "doctor:diana-sharafeddin": "female",
  "doctor:narjes-fadlallah": "female",
  "doctor:hasan-damerji": "male",
  "doctor:daher-roumani": "male",
  "doctor:rola-reslan": "female",
  "doctor:zahraa-badawi": "female",
  "doctor:soleiman-jibawi": "male",
  "doctor:sawsan-el-korsifi": "female",
  "doctor:ezzat-hashem": "male",
  "specialist:taghreed-doueibes": "female",
  "specialist:maya-najdi": "female",
  "specialist:zeinab-makahhel": "female",
});

export function neutralId(id) {
  if (typeof id !== "string" || !id.trim()) throw new Error("Unexpected non-string identifier; migration stopped.");
  return id.startsWith("cedar:") ? id.slice("cedar:".length) : id;
}

export function cloneBson(document) {
  return BSON.deserialize(BSON.serialize(document), { promoteValues: false, promoteLongs: false });
}

export function sameBson(first, second) {
  return BSON.serialize(first).equals(BSON.serialize(second));
}

function remapDay(day) {
  const next = cloneBson(day);
  for (const session of next.doctorSessions ?? []) {
    session.doctorId = neutralId(session.doctorId);
    session.id = neutralId(session.id);
  }
  for (const session of next.specialistSessions ?? []) {
    session.specialistId = neutralId(session.specialistId);
    session.id = neutralId(session.id);
  }
  for (const service of next.otherServices ?? []) service.id = neutralId(service.id);
  validateScheduleDay(next);
  return next;
}

function profile(document, kind) {
  const next = cloneBson(document);
  next._id = neutralId(document._id);
  if (!next._id.startsWith(`${kind}:`) || !Object.hasOwn(CONFIRMED_GENDERS, next._id)) {
    throw new Error(`Unconfirmed profile ${String(document._id)}; request an owner assignment before migration.`);
  }
  if (typeof next.name !== "string" || !next.name.trim() || typeof next.specialty !== "string" || !next.specialty.trim() || typeof next.active !== "boolean") {
    throw new Error(`Invalid profile ${next._id}; migration stopped.`);
  }
  // Set confirmed gender during the old-schema conversion only. A rerun must
  // not reverse later edits to an already-neutral profile's gender or wording.
  if (document._id !== next._id || Object.hasOwn(document, "centerId") || Object.hasOwn(document, "publicationStatus")) {
    next.gender = CONFIRMED_GENDERS[next._id];
  }
  delete next.centerId;
  delete next.publicationStatus;
  delete next.avatarVariant;
  return next;
}

function transform(collection, document) {
  if (Object.hasOwn(document, "centerId") && document.centerId !== "cedar") throw new Error(`Unexpected center scope in ${collection}/${String(document._id)}.`);
  if (collection === COLLECTIONS.doctors) return profile(document, "doctor");
  if (collection === COLLECTIONS.specialists) return profile(document, "specialist");
  const next = cloneBson(document);
  next._id = neutralId(document._id);
  if (collection === COLLECTIONS.weekly) {
    delete next.centerId;
    delete next.source;
    if (!["published", "draft"].includes(next.publicationStatus) || !Object.hasOwn(next, "effectiveFrom") ||
        Object.keys(next.days ?? {}).sort().join() !== "0,1,2,3,4,5,6") throw new Error(`Unexpected weekly structure ${next._id}.`);
    next.days = Object.fromEntries(Object.entries(next.days).map(([key, day]) => [key, remapDay(day)]));
  } else if (collection === COLLECTIONS.changes) {
    delete next.centerId;
    next.weeklyScheduleId = neutralId(next.weeklyScheduleId);
    next.day = remapDay(next.day);
  } else if (collection === COLLECTIONS.seeds) {
    if (next._id !== "approved-weekly-v1" || !Object.hasOwn(next, "completedAt")) throw new Error(`Unexpected seed marker ${next._id}.`);
  }
  return next;
}

export function validateReferences(collections) {
  const doctors = new Map(collections[COLLECTIONS.doctors].map((document) => [document._id, document]));
  const specialists = new Map(collections[COLLECTIONS.specialists].map((document) => [document._id, document]));
  const weeklyIds = new Set(collections[COLLECTIONS.weekly].map((document) => document._id));
  function dayReferences(day, published) {
    for (const [sessions, key, profiles] of [[day.doctorSessions, "doctorId", doctors], [day.specialistSessions, "specialistId", specialists]]) {
      for (const session of sessions) {
        const record = profiles.get(session[key]);
        if (!record || (published && !record.active)) throw new Error(`Broken or inactive published profile reference ${session[key]}.`);
      }
    }
  }
  for (const weekly of collections[COLLECTIONS.weekly]) {
    for (const day of Object.values(weekly.days)) dayReferences(day, weekly.publicationStatus === "published");
  }
  for (const change of collections[COLLECTIONS.changes]) {
    if (!weeklyIds.has(change.weeklyScheduleId)) throw new Error(`Broken weeklyScheduleId ${change.weeklyScheduleId}.`);
    dayReferences(change.day, change.publicationStatus === "published");
  }
}

export const READ_INDEXES = Object.freeze({
  [COLLECTIONS.weekly]: { publicationStatus: 1, effectiveFrom: -1, publishedAt: -1 },
  [COLLECTIONS.changes]: { weeklyScheduleId: 1, date: 1, publicationStatus: 1, publishedAt: -1 },
});

export function buildSchemaCleanupPlan(snapshot) {
  const collections = {};
  const operations = [];
  const indexes = [];
  for (const collection of SCHEMA_COLLECTIONS) {
    const current = snapshot[collection];
    if (!current?.exists) throw new Error(`Required collection ${collection} is absent; refusing initialization during migration.`);
    const seen = new Set();
    collections[collection] = current.documents.map((document) => {
      const next = transform(collection, document);
      if (seen.has(next._id)) throw new Error(`Destination-ID collision in ${collection}: ${next._id}. Nothing may be overwritten.`);
      seen.add(next._id);
      if (!sameBson(document, next)) operations.push({ collection, oldId: document._id, document: next });
      return next;
    });
    const profileCollection = [COLLECTIONS.doctors, COLLECTIONS.specialists].includes(collection);
    const obsolete = (current.indexes ?? []).filter((index) => index.name !== "_id_" &&
      (Object.hasOwn(index.key, "centerId") || (profileCollection && Object.hasOwn(index.key, "publicationStatus")) ||
      (collection === COLLECTIONS.weekly && Object.hasOwn(index.key, "source"))));
    const desired = READ_INDEXES[collection];
    const hasDesired = desired && (current.indexes ?? []).some((index) => !obsolete.includes(index) && sameBson(index.key, desired));
    if (obsolete.length || (desired && !hasDesired)) indexes.push({ collection, drop: obsolete.map(({ name }) => name), create: desired && !hasDesired ? desired : null });
  }
  validateReferences(collections);
  const legacy = snapshot[LEGACY_ARCHIVE_COLLECTION];
  const genders = [...collections[COLLECTIONS.doctors], ...collections[COLLECTIONS.specialists]].reduce((counts, record) => {
    const key = ["male", "female"].includes(record.gender) ? record.gender : "neutral";
    counts[key] += 1;
    return counts;
  }, { male: 0, female: 0, neutral: 0 });
  return {
    collections, operations, indexes,
    archiveLegacy: Boolean(legacy?.exists),
    summary: {
      counts: Object.fromEntries(BACKUP_COLLECTIONS.map((name) => [name, snapshot[name]?.documents.length ?? 0])),
      profileGenders: genders,
      remaps: operations.filter(({ oldId, document }) => oldId !== document._id).map(({ collection, oldId, document }) => ({ collection, from: oldId, to: document._id })),
      changedDocuments: operations.length,
      indexChanges: indexes,
      archiveLegacy: Boolean(legacy?.exists),
      legacyDocuments: legacy?.documents.length ?? 0,
    },
  };
}
