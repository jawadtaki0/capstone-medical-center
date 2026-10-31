import { StaffError } from "./errors.js";
import { validRoles } from "./permissions.js";
import { operationalAccess } from "./operational-model.js";
import { bookingAccess, beirutClock } from "./booking-model.js";
import { publicationChanges } from "./publication-review.js";

export const SUMMARY_VIEWS = "operational_feed_views";
const LIMIT = 2000;
const TIME = 2000;
const unsent = ["pending", "opened", "call_required"];
const unavailable = () =>
  new StaffError(
    "summary_unavailable",
    "Today summaries are temporarily unavailable. Open the relevant screen to review the work.",
    503,
  );

// Explicit initialization only. The normal runtime must approve the additive
// indexes before enabling this service; reading a summary never creates indexes.
export async function ensureOperationalSummaryIndexes(db) {
  for (const [name, keys] of [
    ["website_request_inbox", { scopeId: 1, createdAt: -1, _id: -1 }],
    ["website_request_notices", { scopeId: 1, createdAt: -1, _id: -1 }],
    ["website_request_notices", { scopeId: 1, "history.at": -1, _id: -1 }],
    ["website_request_events", { state: 1, lastError: 1, requestId: 1 }],
    [
      "public_publication_outbox",
      { scopeIds: 1, state: 1, acceptedAt: -1, _id: -1 },
    ],
    ["public_publication_outbox", { scopeIds: 1, state: 1, lastError: 1 }],
    ["operational_publications", { scopeIds: 1, sequence: -1 }],
    ["operational_publications", { publishesHours: 1, sequence: -1 }],
  ])
    await db.collection(name).createIndex(keys);
}

const fields = {
  scopes: ["id", "name", "kind", "active"],
  professionals: [
    "id",
    "name",
    "specialty",
    "kind",
    "gender",
    "active",
    "scopeIds",
  ],
  sessions: [
    "id",
    "scopeId",
    "professionalId",
    "weekday",
    "startTime",
    "endTime",
    "status",
    "appointmentRequired",
  ],
  exceptions: ["id", "scopeId", "date", "closed", "sessions"],
  hours: ["id", "closed", "startTime", "endTime"],
};
const fingerprint = (type, record) =>
  JSON.stringify(
    Object.fromEntries(
      fields[type]
        .filter((k) => Object.hasOwn(record, k))
        .map((k) => [
          k,
          k === "scopeIds"
            ? [...record[k]].sort()
            : k === "sessions"
              ? [...record[k]]
                  .sort((a, b) => a.id.localeCompare(b.id))
                  .map((s) => fingerprint("sessions", s))
              : record[k],
        ]),
    ),
  );
const allScopes = (ids) => ({ $in: ids, $not: { $elemMatch: { $nin: ids } } });

function noticeJoin(at, scopes, inboxName) {
  return [
    {
      $lookup: {
        from: inboxName,
        localField: "requestId",
        foreignField: "_id",
        as: "request",
        pipeline: [
          {
            $project: {
              _id: 1,
              scopeId: 1,
              expiresAt: 1,
              sequence: 1,
              generation: 1,
              purgedAt: 1,
              rotation: 1,
            },
          },
        ],
      },
    },
    { $unwind: "$request" },
    {
      $match: {
        "request.scopeId": { $in: scopes },
        "request.expiresAt": { $gt: at },
        "request.purgedAt": { $exists: false },
        "request.rotation": { $exists: false },
        $expr: {
          $and: [
            { $eq: ["$scopeId", "$request.scopeId"] },
            { $eq: ["$version", "$request.sequence"] },
            { $eq: ["$generation", "$request.generation"] },
          ],
        },
      },
    },
  ];
}

export function createOperationalSummaryService({
  db,
  transaction,
  authenticated,
  now,
}) {
  const collection = (name) => db.collection(name);
  async function execute(action) {
    try {
      return await transaction(action);
    } catch (error) {
      if (error instanceof StaffError) throw error;
      throw unavailable();
    }
  }
  const inboxName = () => {
    const name = collection("website_request_inbox").collectionName;
    if (typeof name !== "string" || !/^[a-z0-9_]+$/.test(name))
      throw unavailable();
    return name;
  };
  async function bounded(name, query, projection, session) {
    const values = await collection(name)
      .find(query, { session, projection })
      .limit(LIMIT + 1)
      .maxTimeMS(TIME)
      .toArray();
    if (values.length > LIMIT) throw unavailable();
    return values;
  }
  async function authority(session, context) {
    const roles = context.account.roles;
    if (!validRoles(roles))
      throw new StaffError(
        "permission_denied",
        "Today is unavailable for your current roles.",
        403,
      );
    const scopes = await collection("operational_scopes")
      .find({}, { session, projection: { _id: 0, id: 1, kind: 1, active: 1 } })
      .limit(101)
      .maxTimeMS(TIME)
      .toArray();
    if (scopes.length > 100) throw unavailable();
    const grant = await collection("operational_grants").findOne(
      { _id: context.account._id },
      { session, projection: { scopeIds: 1 } },
    );
    const ids = grant?.scopeIds ?? [];
    if (!Array.isArray(ids) || ids.length > 100) throw unavailable();
    const access = (s) => operationalAccess(roles, ids, s);
    return {
      admin: roles.includes("Admin"),
      requests: scopes
        .filter((s) => bookingAccess(roles, ids, s))
        .map((s) => s.id),
      bookings: scopes
        .filter(
          (s) =>
            s.kind === "clinic" &&
            operationalAccess(roles, ids, { ...s, active: true }).view,
        )
        .map((s) => s.id),
      visible: scopes.filter((s) => access(s).view).map((s) => s.id),
      editable: scopes.filter((s) => access(s).edit).map((s) => s.id),
      clinicEdit: scopes
        .filter((s) => s.kind === "clinic" && access(s).edit)
        .map((s) => s.id),
      serviceEdit: scopes
        .filter((s) => s.kind === "service" && access(s).edit)
        .map((s) => s.id),
    };
  }
  async function snapshot(query, session) {
    const projected = Object.fromEntries(
      Object.keys(fields).map((key) => [
        key,
        { $slice: [{ $ifNull: [`$${key}`, []] }, LIMIT + 1] },
      ]),
    );
    const found = await collection("operational_publications")
      .aggregate(
        [
          { $match: query },
          { $sort: { sequence: -1 } },
          { $limit: 1 },
          { $project: { ...projected, _id: 0, sequence: 1 } },
        ],
        { session, maxTimeMS: TIME },
      )
      .toArray();
    if (found.some((p) => Object.keys(fields).some((k) => p[k].length > LIMIT)))
      throw unavailable();
    return found[0];
  }
  async function unpublished(a, session) {
    const scopeSnapshots = new Map();
    const published = Object.fromEntries(
      Object.keys(fields).map((key) => [key, new Map()]),
    );
    // The latest authoring event for EACH scope includes future-scheduled edits.
    // A later unrelated-scope publication must not make those edits look dirty.
    for (const scopeId of a.editable) {
      const p = await snapshot({ scopeIds: scopeId }, session);
      if (!p) continue;
      scopeSnapshots.set(scopeId, p);
      for (const key of ["scopes", "professionals", "sessions", "exceptions"])
        for (const record of p[key]) {
          const relevant =
            key === "scopes"
              ? record.id === scopeId
              : key === "professionals"
                ? record.scopeIds.includes(scopeId)
                : record.scopeId === scopeId;
          if (
            relevant &&
            (!published[key].has(record.id) ||
              published[key].get(record.id).sequence < p.sequence)
          )
            published[key].set(record.id, {
              sequence: p.sequence,
              value: fingerprint(key, record),
            });
        }
    }
    if (a.admin) {
      const p = await snapshot({ publishesHours: true }, session);
      for (const record of p?.hours ?? [])
        published.hours.set(record.id, { value: fingerprint("hours", record) });
    }
    let count = 0;
    for (const [name, type, query] of [
      [
        "doctor_profile_drafts",
        "professionals",
        { scopeIds: allScopes(a.editable) },
      ],
      [
        "specialist_profile_drafts",
        "professionals",
        { scopeIds: allScopes(a.editable) },
      ],
      [
        "operational_session_drafts",
        "sessions",
        { scopeId: { $in: a.editable } },
      ],
      [
        "operational_date_drafts",
        "exceptions",
        { scopeId: { $in: a.editable } },
      ],
      ...(a.admin
        ? [
            ["operational_scopes", "scopes", {}],
            ["operational_hours_drafts", "hours", {}],
          ]
        : []),
    ]) {
      const projection = Object.fromEntries(
        fields[type].map((key) => [key, 1]),
      );
      for (const record of await bounded(name, query, projection, session)) {
        if (published[type].get(record.id)?.value === fingerprint(type, record))
          continue;
        // A private date-specific limit may introduce a replacement record
        // identical to inherited public hours. That is not a website edit.
        if (type === "exceptions" && !published.exceptions.has(record.id)) {
          const prior = scopeSnapshots.get(record.scopeId);
          if (
            prior &&
            publicationChanges(prior, {
              ...prior,
              exceptions: [
                ...prior.exceptions.filter(
                  (e) =>
                    !(e.scopeId === record.scopeId && e.date === record.date),
                ),
                record,
              ],
            }).total === 0
          )
            continue;
        }
        count++;
      }
    }
    return count;
  }
  async function noticeCount(a, at, session) {
    const result = await collection("website_request_notices")
      .aggregate(
        [
          { $match: { scopeId: { $in: a.requests }, state: { $in: unsent } } },
          ...noticeJoin(at, a.requests, inboxName()),
          { $count: "count" },
        ],
        { session, maxTimeMS: TIME },
      )
      .toArray();
    return result[0]?.count ?? 0;
  }
  async function feed(a, at, session) {
    const items = [];
    if (a.requests.length) {
      const requests = await collection("website_request_inbox")
        .find(
          {
            scopeId: { $in: a.requests },
            source: { $ne: "phone" },
            purgedAt: { $exists: false },
          },
          { session, projection: { _id: 1, createdAt: 1, status: 1 } },
        )
        .sort({ createdAt: -1, _id: -1 })
        .limit(3)
        .maxTimeMS(TIME)
        .toArray();
      for (const r of requests)
        items.push({
          id: `request:${r._id}`,
          kind: "request",
          label: "Website request received",
          at: r.createdAt,
          needsAction: r.status === "awaiting",
          target: { section: "requests", recordId: r._id },
        });
      // Union latest created notices and latest history changes, so an older
      // notice marked sent today is not hidden by newer-created notices.
      const notices = new Map();
      for (const sort of [
        { createdAt: -1, _id: -1 },
        { "history.at": -1, _id: -1 },
      ]) {
        const records = await collection("website_request_notices")
          .aggregate(
            [
              {
                $match: {
                  scopeId: { $in: a.requests },
                  state: { $ne: "superseded" },
                },
              },
              { $sort: sort },
              ...noticeJoin(at, a.requests, inboxName()),
              { $limit: 3 },
              {
                $project: {
                  _id: 1,
                  state: 1,
                  createdAt: 1,
                  history: { $slice: [{ $ifNull: ["$history", []] }, -1] },
                  lastOpeningOutcome: 1,
                },
              },
            ],
            { session, maxTimeMS: TIME },
          )
          .toArray();
        for (const n of records) notices.set(n._id, n);
      }
      for (const n of notices.values()) {
        const last = n.history?.at(-1);
        items.push({
          id: `notice:${n._id}:${n.state}:${n.lastOpeningOutcome ?? "none"}`,
          kind: "notice",
          label:
            n.lastOpeningOutcome === "open_failed" && unsent.includes(n.state)
              ? "Message opening needs attention"
              : unsent.includes(n.state)
                ? "Message not sent"
                : n.state === "call_recorded"
                  ? "Call outcome recorded"
                  : "Message marked sent by staff",
          at: last?.at ?? n.createdAt,
          needsAction: unsent.includes(n.state),
          actionState: unsent.includes(n.state)
            ? n.lastOpeningOutcome === "open_failed"
              ? "failure"
              : "pending"
            : "resolved",
          target: { section: "requests", tab: "messages", noticeId: n._id },
        });
      }
    }
    if (a.visible.length) {
      const publications = await collection("public_publication_outbox")
        .find(
          { scopeIds: { $in: a.visible }, state: "accepted" },
          { session, projection: { _id: 1, acceptedAt: 1, effectiveFrom: 1 } },
        )
        .sort({ acceptedAt: -1, _id: -1 })
        .limit(3)
        .maxTimeMS(TIME)
        .toArray();
      for (const p of publications)
        items.push({
          id: `publication:${p._id}`,
          kind: "publication",
          label: "Website update accepted",
          at: p.acceptedAt,
          needsAction: false,
          effectiveFrom: p.effectiveFrom,
          target: { section: "website", publicationId: p._id },
        });
    }
    return items
      .filter((e) => e.at instanceof Date && Number.isFinite(e.at.getTime()))
      .sort((a, b) => +b.at - +a.at || a.id.localeCompare(b.id))
      .slice(0, 3)
      .map((e) => ({ ...e, at: e.at.toISOString(), resolved: !e.needsAction }));
  }
  async function context(session, token) {
    const at = now(),
      ctx = await authenticated(session, token, at);
    if (ctx.failure) return { failure: ctx.failure };
    return { at, ctx, authority: await authority(session, ctx) };
  }
  return {
    read: (token) =>
      execute(async (session) => {
        const c = await context(session, token);
        if (c.failure) return c;
        const { authority: a, at, ctx } = c,
          counts = {};
        const options = { session, maxTimeMS: TIME };
        if (a.requests.length) {
          counts.requestsAwaitingDecision = await collection(
            "website_request_inbox",
          ).countDocuments(
            {
              scopeId: { $in: a.requests },
              status: "awaiting",
              purgedAt: { $exists: false },
              source: { $ne: "phone" },
            },
            options,
          );
          counts.messagesToSend = await noticeCount(a, at, session);
          const failures = await collection("website_request_events")
            .aggregate(
              [
                {
                  $match: {
                    state: "pending",
                    lastError: { $exists: true, $ne: null },
                  },
                },
                {
                  $lookup: {
                    from: inboxName(),
                    localField: "requestId",
                    foreignField: "_id",
                    as: "request",
                    pipeline: [{ $project: { scopeId: 1, purgedAt: 1 } }],
                  },
                },
                { $unwind: "$request" },
                {
                  $match: {
                    "request.scopeId": { $in: a.requests },
                    "request.purgedAt": { $exists: false },
                  },
                },
                { $count: "count" },
              ],
              options,
            )
            .toArray();
          counts.trackingDeliveryProblems = failures[0]?.count ?? 0;
        }
        if (a.bookings.length)
          counts.todayBookings = await collection("bookings").countDocuments(
            {
              scopeId: { $in: a.bookings },
              date: beirutClock(at).date,
              status: "confirmed",
            },
            options,
          );
        if (a.editable.length || a.admin) {
          counts.unpublishedChanges = await unpublished(a, session);
          counts.publicationDeliveryProblems = await collection(
            "public_publication_outbox",
          ).countDocuments(
            {
              scopeIds: allScopes(a.editable),
              state: { $in: ["pending", "failed"] },
              lastError: { $exists: true, $ne: null },
            },
            options,
          );
        }
        const recent = await feed(a, at, session),
          saved = await collection(SUMMARY_VIEWS).findOne(
            { _id: ctx.account._id },
            { session, projection: { events: 1 } },
          );
        return {
          timeZone: "Asia/Beirut",
          date: beirutClock(at).date,
          counts,
          capabilities: {
            directory: a.admin,
            patients: true,
            book: Boolean(a.requests.length),
            bookingView: Boolean(a.bookings.length),
            requests: Boolean(a.requests.length),
            professionals: Boolean(a.clinicEdit.length),
            schedules: Boolean(a.editable.length),
            operations: Boolean(a.visible.length || a.admin),
            serviceHours: Boolean(a.serviceEdit.length),
            centerSettings: a.admin,
          },
          activity: recent.map((e) => ({
            ...e,
            viewed: Boolean(saved?.events?.some((v) => v.id === e.id)),
          })),
        };
      }),
    viewed: (token, input) =>
      execute(async (session) => {
        if (
          !input ||
          Object.keys(input).some((k) => k !== "eventId") ||
          typeof input.eventId !== "string" ||
          !/^[A-Za-z0-9:_-]{1,200}$/.test(input.eventId)
        )
          throw new StaffError(
            "invalid_input",
            "Choose a current activity item.",
            400,
          );
        const c = await context(session, token);
        if (c.failure) return c;
        const recent = await feed(c.authority, c.at, session);
        if (!recent.some((e) => e.id === input.eventId))
          throw new StaffError(
            "summary_stale",
            "This activity is no longer available. Refresh Today.",
            409,
          );
        const saved = await collection(SUMMARY_VIEWS).findOne(
          { _id: c.ctx.account._id },
          { session, projection: { events: 1 } },
        );
        const events = recent.flatMap((e) =>
          e.id === input.eventId
            ? [{ id: e.id, at: c.at }]
            : (saved?.events ?? []).filter((v) => v.id === e.id).slice(0, 1),
        );
        await collection(SUMMARY_VIEWS).updateOne(
          { _id: c.ctx.account._id },
          { $set: { events } },
          { session, upsert: true },
        );
        return { viewed: true, eventId: input.eventId };
      }),
  };
}
