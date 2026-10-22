import { randomUUID } from "node:crypto";
import { StaffError } from "./errors.js";
import { allowFields, expectedRevision } from "./management-validation.js";
import {
  identifier,
  dateOnly,
  validateOperationalRecord,
  operationalAccess,
  assertNoOverlap,
} from "./operational-model.js";
import {
  validatePublication,
  publicSnapshotDatabase,
  composePublications,
} from "./operational-publication.js";

export const OPERATIONAL_COLLECTIONS = Object.freeze({
  scopes: "operational_scopes",
  grants: "operational_grants",
  doctors: "doctor_profile_drafts",
  specialists: "specialist_profile_drafts",
  sessions: "operational_session_drafts",
  exceptions: "operational_date_drafts",
  hours: "operational_hours_drafts",
  state: "operational_state",
  publications: "operational_publications",
});
const denied = () =>
  new StaffError(
    "permission_denied",
    "This action is outside your assigned operational scope.",
    403,
  );
const stale = () =>
  new StaffError(
    "stale_record",
    "This draft, assignment or publication changed. Reload before saving.",
    409,
  );
const listIds = (value) => {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    new Set(value).size !== value.length
  )
    throw new StaffError(
      "invalid_input",
      "Choose unique assigned scope IDs (up to 100).",
    );
  return value.map(identifier);
};
export function createOperationsService({
  db,
  transaction,
  guard,
  authenticated,
  now,
  recentVerificationExpiry,
}) {
  const collection = (type) => db.collection(OPERATIONAL_COLLECTIONS[type]);
  const admin = (context) => context.account.roles.includes("Admin");
  async function load(session) {
    const values = {};
    for (const type of [
      "scopes",
      "grants",
      "doctors",
      "specialists",
      "sessions",
      "exceptions",
      "hours",
    ])
      values[type] = await collection(type).find({}, { session }).toArray();
    const state = await collection("state").findOne(
      { _id: "working" },
      { session },
    );
    return {
      ...values,
      professionals: [...values.doctors, ...values.specialists],
      revision: state?.revision ?? 0,
      head: state?.head ?? 0,
    };
  }
  const grantsFor = (data, id) =>
    data.grants.find((g) => g.id === id)?.scopeIds ?? [];
  const access = (context, data, scopeId) => {
    const scope = data.scopes.find((s) => s.id === scopeId);
    return scope
      ? operationalAccess(
          context.account.roles,
          grantsFor(data, context.account._id),
          scope,
        )
      : { view: false, edit: false, publish: false };
  };
  function authorized(context, data, ids, mode = "edit") {
    if (!ids.length || !ids.every((id) => access(context, data, id)[mode]))
      throw denied();
  }
  async function run(token, write, action) {
    return transaction(async (session) => {
      if (write) await guard(session);
      const at = now(),
        context = await authenticated(session, token, at);
      if (context.failure) return context;
      const data = await load(session);
      return action(session, context, data, at);
    });
  }
  function recent(context, at) {
    if (!recentVerificationExpiry(context.record, context.account, at))
      throw new StaffError(
        "verification_required",
        "Verify your password and MFA before changing registry/assignments or publishing.",
        403,
      );
  }
  async function changed(session, context, action, target, at) {
    await collection("state").updateOne(
      { _id: "working" },
      { $inc: { revision: 1 }, $setOnInsert: { head: 0 } },
      { session, upsert: true },
    );
    await db.collection("security_events").insertOne(
      {
        _id: randomUUID(),
        actorId: context.account._id,
        action: `operational_${action}`,
        targetId: target,
        occurredAt: at,
        outcome: "success",
      },
      { session },
    );
  }
  function references(data) {
    for (const p of data.professionals)
      if (
        p.scopeIds.some(
          (id) => !data.scopes.some((s) => s.id === id && s.kind === "clinic"),
        )
      )
        throw new StaffError(
          "invalid_input",
          "Professional profiles must reference existing clinics, not services.",
        );
    for (const item of [
      ...data.sessions,
      ...data.exceptions.flatMap((e) => e.sessions),
    ]) {
      const scope = data.scopes.find((s) => s.id === item.scopeId),
        profile = data.professionals.find((p) => p.id === item.professionalId);
      if (
        !scope ||
        (scope.kind === "clinic" &&
          (!profile || !profile.scopeIds.includes(scope.id))) ||
        (scope.kind === "service" && item.professionalId !== null)
      )
        throw new StaffError(
          "invalid_input",
          "A session must reference a professional assigned to that clinic, or service hours without a professional.",
        );
    }
    for (const e of data.exceptions)
      if (!data.scopes.some((s) => s.id === e.scopeId))
        throw new StaffError(
          "invalid_input",
          "A dated change needs an existing clinic/service.",
        );
    const keys = data.exceptions.map((e) => `${e.scopeId}:${e.date}`);
    if (new Set(keys).size !== keys.length)
      throw new StaffError(
        "invalid_input",
        "Edit the existing exception for that scope and date.",
      );
    assertNoOverlap(data.sessions, data.exceptions);
  }
  return {
    read: (token) =>
      run(token, false, async (_session, context, data) => {
        const scopes = data.scopes
          .filter((s) => access(context, data, s.id).view)
          .map((s) => ({ ...s, access: access(context, data, s.id) }));
        const visible = new Set(scopes.map((s) => s.id));
        const publication = composePublications(
          await collection("publications")
            .find({}, { session: _session })
            .toArray(),
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Beirut",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(now()),
        );
        const editable = new Set(
          scopes.filter((s) => s.access.edit).map((s) => s.id),
        );
        const scoped = (key) => [
          ...data[key].filter((r) => editable.has(r.scopeId)),
          ...(publication?.[key] ?? []).filter(
            (r) => visible.has(r.scopeId) && !editable.has(r.scopeId),
          ),
        ];
        const professionals = [
          ...data.professionals.filter((p) =>
            p.scopeIds.some((id) => editable.has(id)),
          ),
          ...(publication?.professionals ?? []).filter(
            (p) =>
              !p.scopeIds.some((id) => editable.has(id)) &&
              p.scopeIds.some((id) => visible.has(id)),
          ),
        ];
        return {
          boundary: "isolated-local-publication",
          timeZone: "Asia/Beirut",
          revision: data.revision,
          head: data.head,
          isAdmin: admin(context),
          scopes,
          professionals: professionals.map((p) => ({
            ...p,
            canEdit: p.scopeIds.every((id) => access(context, data, id).edit),
          })),
          sessions: scoped("sessions"),
          exceptions: scoped("exceptions"),
          hours:
            admin(context) || editable.size
              ? data.hours
              : (publication?.hours ?? []),
          grants: admin(context) ? data.grants : [],
        };
      }),
    save: (token, input) =>
      run(token, true, async (session, context, data, at) => {
        allowFields(input, ["type", "record", "expectedRevision"]);
        const value = validateOperationalRecord(input.type, input.record),
          revision = expectedRevision(input.expectedRevision);
        const old = data[input.type].find((v) => v.id === value.id);
        if ((old?.revision ?? 0) !== revision) throw stale();
        if (["scopes", "hours"].includes(input.type)) {
          if (!admin(context)) throw denied();
          recent(context, at);
        } else if (input.type === "professionals") {
          authorized(context, data, [
            ...new Set([...(old?.scopeIds ?? []), ...value.scopeIds]),
          ]);
          if (old && old.kind !== value.kind)
            throw new StaffError(
              "invalid_input",
              "Professional kind and identifier cannot change.",
            );
        } else
          authorized(context, data, [
            ...new Set([old?.scopeId, value.scopeId].filter(Boolean)),
          ]);
        if (old && input.type === "scopes" && old.kind !== value.kind)
          throw new StaffError(
            "invalid_input",
            "A registry record cannot change kind.",
          );
        const next = { ...value, revision: revision + 1 };
        data[input.type] = [
          ...data[input.type].filter((v) => v.id !== value.id),
          next,
        ];
        references(data);
        const type =
          input.type === "professionals"
            ? value.kind === "doctor"
              ? "doctors"
              : "specialists"
            : input.type;
        await collection(type).replaceOne(
          { _id: value.id },
          { _id: value.id, ...next },
          { session, upsert: true },
        );
        await changed(session, context, `save_${input.type}`, value.id, at);
        return { saved: true, revision: next.revision };
      }),
    grants: (token, input) =>
      run(token, true, async (session, context, data, at) => {
        allowFields(input, [
          "accountId",
          "scopeIds",
          "expectedRevision",
          "confirmed",
        ]);
        if (!admin(context)) throw denied();
        recent(context, at);
        const id = identifier(input.accountId),
          scopeIds = listIds(input.scopeIds),
          revision = expectedRevision(input.expectedRevision);
        if (input.confirmed !== true || id === context.account._id)
          throw new StaffError(
            "invalid_input",
            "Confirm assignments for another staff account. Admin already has full operational authority.",
          );
        const target = await db
          .collection("accounts")
          .findOne({ _id: id }, { session });
        if (!target || target.status === "disabled")
          throw new StaffError(
            "invalid_input",
            "Choose an existing enabled staff account.",
          );
        if (
          scopeIds.some(
            (scopeId) => !data.scopes.some((s) => s.id === scopeId && s.active),
          )
        )
          throw new StaffError(
            "invalid_input",
            "Choose existing active clinics/services.",
          );
        const old = data.grants.find((g) => g.id === id);
        if ((old?.revision ?? 0) !== revision) throw stale();
        await collection("grants").replaceOne(
          { _id: id },
          { _id: id, id, scopeIds, revision: revision + 1 },
          { upsert: true, session },
        );
        await changed(session, context, "assign_scopes", id, at);
        return { saved: true, revision: revision + 1 };
      }),
    publish: (token, input) =>
      run(token, true, async (session, context, data, at) => {
        allowFields(input, [
          "scopeIds",
          "expectedRevision",
          "expectedHead",
          "effectiveFrom",
          "confirmed",
        ]);
        const scopeIds = listIds(input.scopeIds);
        authorized(context, data, scopeIds, "publish");
        recent(context, at);
        if (input.confirmed !== true)
          throw new StaffError(
            "invalid_input",
            "Confirm publication of these assigned scopes.",
          );
        if (
          expectedRevision(input.expectedRevision) !== data.revision ||
          expectedRevision(input.expectedHead) !== data.head
        )
          throw stale();
        const effectiveFrom = dateOnly(input.effectiveFrom);
        const events = await collection("publications")
          .find({}, { session })
          .toArray();
        const prior = composePublications(events, effectiveFrom);
        const selected = new Set(scopeIds),
          base = prior ?? {
            scopes: [],
            professionals: [],
            sessions: [],
            exceptions: [],
            hours: [],
          };
        const replaceScoped = (key) => [
          ...base[key].filter(
            (r) => !selected.has(key === "scopes" ? r.id : r.scopeId),
          ),
          ...data[key].filter((r) =>
            selected.has(key === "scopes" ? r.id : r.scopeId),
          ),
        ];
        const professionals = [...base.professionals];
        for (const p of data.professionals.filter((p) =>
          p.scopeIds.some((id) => selected.has(id)),
        )) {
          const old = professionals.find((r) => r.id === p.id);
          if (!p.scopeIds.every((id) => selected.has(id))) {
            if (!old || old.revision !== p.revision)
              throw new StaffError(
                "publication_conflict",
                "Publish every linked clinic together when changing a shared professional profile.",
                409,
              );
          } else {
            const index = professionals.findIndex((r) => r.id === p.id);
            if (index < 0) professionals.push(p);
            else professionals[index] = p;
          }
        }
        const next = {
          id: `publication:${data.head + 1}`,
          sequence: data.head + 1,
          effectiveFrom,
          publishedAt: at.toISOString(),
          scopeIds,
          publishesHours: admin(context),
          scopes: replaceScoped("scopes"),
          professionals,
          sessions: replaceScoped("sessions"),
          exceptions: replaceScoped("exceptions"),
          hours: admin(context) ? data.hours : base.hours,
        };
        references(next);
        validatePublication(next);
        for (const boundary of new Set(
          events
            .filter((event) => event.effectiveFrom > effectiveFrom)
            .map((event) => event.effectiveFrom),
        )) {
          const future = composePublications([...events, next], boundary);
          references(future);
          validatePublication(future);
        }
        await collection("publications").insertOne(
          { _id: next.id, ...next },
          { session },
        );
        await changed(session, context, "publish", next.id, at);
        await collection("state").updateOne(
          { _id: "working" },
          { $set: { head: data.head + 1 } },
          { session },
        );
        return {
          published: true,
          head: data.head + 1,
          boundary: "isolated-local-publication",
        };
      }),
    preview: (token, input) =>
      run(token, false, async (session, context, data) => {
        allowFields(input, ["date"]);
        const date = dateOnly(input.date);
        if (!admin(context)) throw denied();
        const snapshot = composePublications(
          await collection("publications").find({}, { session }).toArray(),
          date,
        );
        if (!snapshot)
          return { boundary: "isolated-local-publication", unpublished: true };
        const { getPublicProfessionals } =
          await import("../../api/src/professionals.js");
        const { getScheduleForDate } =
          await import("../../api/src/schedule.js");
        return {
          boundary: "isolated-local-publication",
          head: data.head,
          professionals: await getPublicProfessionals(
            publicSnapshotDatabase(snapshot),
          ),
          schedule: await getScheduleForDate(
            date,
            publicSnapshotDatabase(snapshot, "schedule"),
          ),
        };
      }),
  };
}
