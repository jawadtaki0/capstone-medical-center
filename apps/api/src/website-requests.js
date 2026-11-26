import { patientCancellationMessage } from "../../../shared/patient-cancellation-message.mjs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  cancellationEligibility,
  cancellationReasons,
} from "./patient-cancellation.js";
import {
  availabilitySlot,
  publicAvailability,
  validateAvailability,
  AVAILABILITY_FRESH_MS,
} from "../../../shared/session-availability.mjs";
import {
  exact,
  secret,
  text,
  calendarDate,
  intakeInput,
  beirutEnd,
  publicRequest,
  REQUEST_REASONS,
  requestFail,
} from "../../../shared/website-request-contract.mjs";
import {
  requestCrypto,
  guestCancellationPath,
  randomToken,
  digest,
  requestTransaction,
  consumeCounter,
} from "../../../shared/website-request-security.mjs";
export const PUBLIC_INTAKE_COLLECTIONS = [
  "website_requests",
  "website_request_state",
  "website_request_counters",
];
export async function ensureIntakeIndexes(db) {
  const r = db.collection("website_requests");
  await r.createIndex(
    { tokenHash: 1 },
    {
      unique: true,
      partialFilterExpression: { tokenHash: { $type: "string" } },
    },
  );
  await r.createIndex({ reference: 1 }, { unique: true });
  await r.createIndex({ ordinal: 1 }, { unique: true });
  await r.createIndex({ phoneKey: 1, createdAt: 1 });
  await r.createIndex({ cleanupAt: 1 });
  await r.createIndex(
    { "owner.accountId": 1, "owner.profileId": 1, createdAt: -1 },
    {
      partialFilterExpression: { "owner.accountId": { $exists: true } },
    },
  );
  await db
    .collection("website_request_counters")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
export function createPublicIntake({
  db,
  client,
  key,
  sessionReader,
  professionalReader = async () => [],
  upcomingReader = null,
  clock = () => new Date(),
  limits = {},
  localReviewOnly = true,
  cancellationCutoffMinutes = 120,
  deliverCancellationEmail,
  cancellationContact,
}) {
  if (
    !Number.isSafeInteger(cancellationCutoffMinutes) ||
    cancellationCutoffMinutes < 0
  )
    throw Error("Invalid patient cancellation cutoff.");
  if (typeof localReviewOnly !== "boolean")
    throw Error("An explicit review-location flag is required.");
  const crypto = requestCrypto(key),
    requests = db.collection("website_requests"),
    tx = (action) => requestTransaction(client, action);
  const policy = {
    submitMinute: 10,
    submitHour: 60,
    trackingSource: 60,
    trackingToken: 12,
    ...limits,
  };
  const projection = {
    _id: 1,
    reference: 1,
    ordinal: 1,
    payloadVersion: 1,
    payloadDigest: 1,
    patient: 1,
    selection: 1,
    endsAt: 1,
    expiresAt: 1,
    createdAt: 1,
    generation: 1,
    tokenEnvelope: 1,
    phoneReview: 1,
    owner: 1,
  };
  async function count(source, type, limit, ms = 60000) {
    await consumeCounter(
      db,
      `${type}:${crypto.source(source)}`,
      limit,
      ms,
      clock(),
    );
  }
  function alive(r) {
    if (!r || r.purgedAt || r.expiresAt <= clock())
      throw requestFail(
        "request_unavailable",
        "This request link is unavailable.",
        410,
      );
  }
  function envelope(r) {
    return {
      requestId: r._id,
      reference: r.reference,
      trackingToken: crypto.open(r.tokenEnvelope, `${r._id}:${r.generation}`)
        .token,
      expiresAt: r.expiresAt,
      selection: r.selection,
      language: r.language,
      ...guestCancellationLink(r),
    };
  }
  const unavailableCancellation = () =>
    requestFail(
      "cancellation_unavailable",
      "This cancellation is unavailable. Contact Reception for help.",
      404,
    );
  const cancelState = (row) =>
    cancellationEligibility(row, clock(), cancellationCutoffMinutes);
  const bookingDto = (row) => ({
    ...publicRequest(row, clock(), { localReviewOnly }),
    specialty: row.selection.specialty ?? null,
    cancellation: cancelState(row),
  });
  const guestExpiry = (row) =>
    Math.min(
      +row.expiresAt,
      +beirutEnd(row.selection.date, row.selection.startTime) -
        cancellationCutoffMinutes * 60_000,
    );
  const guestPath = (row) =>
    guestCancellationPath(crypto, row._id, guestExpiry(row), row.generation);
  const guestProof = (row) => guestPath(row).slice("/cancel#".length);
  const guestCancellationLink = (row) =>
    !row.owner && cancelState(row).eligible
      ? { cancellationLink: guestPath(row) }
      : {};
  async function applyCancellation(filter, input, actor, authorize) {
    exact(input, ["confirmed", "reasons", "note"], ["confirmed"]);
    if (input.confirmed !== true)
      throw requestFail(
        "cancellation_confirmation",
        "Confirm the cancellation before continuing.",
        400,
      );
    const reasons = cancellationReasons(input.reasons, input.note);
    return tx(async (session) => {
      const row = await requests.findOne(filter, { session });
      if (
        !row ||
        row.purgedAt ||
        row.expiresAt <= clock() ||
        !(await authorize(row, session))
      )
        throw unavailableCancellation();
      if (row.status === "cancelled_by_patient" && actor.channel === "account")
        return { status: row.status };
      const eligibility = cancelState(row);
      if (!eligibility.eligible)
        throw requestFail(
          "cancellation_" + eligibility.reason,
          "Online cancellation is unavailable for this booking. Contact Reception for help.",
          409,
        );
      const at = clock();
      const cancellation = { at, ...actor, reasons };
      await requests.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "cancelled_by_patient",
            patientCancellation: cancellation,
            cancellationSyncPending: true,
            ...(actor.channel === "account" && deliverCancellationEmail
              ? { cancellationEmailState: "pending" }
              : {}),
          },
          $push: { events: { status: "cancelled_by_patient", at } },
        },
        { session },
      );
      return { status: "cancelled_by_patient" };
    });
  }
  const ownedBy = (owner, reference) => ({
    reference,
    "owner.accountId": owner.accountId,
    "owner.profileId": owner.profileId,
  });
  async function guestRow(proof, source) {
    await count(source, "cancel-guest-source", 12);
    if (
      typeof proof !== "string" ||
      !/^[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/u.test(proof)
    )
      throw unavailableCancellation();
    const [id, expiry] = proof.split(".");
    await count(id, "cancel-guest-request", 6);
    if (Number(expiry) < +clock()) throw unavailableCancellation();
    return {
      filter: { _id: id, owner: { $exists: false } },
      verify: (row) => {
        const expected = guestProof(row);
        return (
          proof.length === expected.length &&
          timingSafeEqual(Buffer.from(proof), Buffer.from(expected)) &&
          row.status !== "cancelled_by_patient"
        );
      },
    };
  }
  async function sendPatientCancellationEmail(requestId) {
    if (!deliverCancellationEmail) return;
    // Claim before calling the sender. An uncertain outcome requires review;
    // repeating a Gmail send after a timeout could send two emails.
    const row = await requests.findOneAndUpdate(
      {
        _id: requestId,
        status: "cancelled_by_patient",
        cancellationEmailState: "pending",
      },
      { $set: { cancellationEmailState: "sending" } },
      { returnDocument: "after" },
    );
    if (!row) return;
    let state = "failed";
    try {
      const account = await db.collection("patient_accounts").findOne({
        _id: row.owner.accountId,
        emailVerifiedAt: { $exists: true },
      });
      if (account?.email) {
        const {
          professionalName: professional,
          date,
          startTime,
          endTime,
        } = row.selection;
        const { subject, text: message } = patientCancellationMessage(
          {
            professional,
            date,
            startTime,
            endTime,
            contact: cancellationContact,
          },
          row.language,
        );
        await deliverCancellationEmail({
          to: account.email,
          purpose: "booking-cancellation",
          subject,
          message,
        });
        state = "sent";
      }
    } finally {
      await requests.updateOne(
        { _id: row._id, cancellationEmailState: "sending" },
        { $set: { cancellationEmailState: state } },
      );
    }
  }
  async function availability(sessions) {
    const states = db.collection("website_request_state"),
      at = clock();
    for (const date of new Set(sessions.map((s) => s.date))) {
      await states.updateOne(
        { _id: `availability-demand:${availabilitySlot(date)}` },
        { $set: { kind: "availability-demand", date, requestedAt: at } },
        { upsert: true },
      );
    }
    const snapshots = new Map();
    for (const date of new Set(sessions.map((s) => s.date)))
      snapshots.set(
        date,
        await states.findOne({
          _id: `availability:${availabilitySlot(date)}`,
          date,
        }),
      );
    return sessions.map((s) => ({
      ...s,
      availability: publicAvailability(s, snapshots.get(s.date)?.payload, at),
      availabilityExpiresAt: snapshots.get(s.date)?.payload?.generatedAt
        ? new Date(
            Date.parse(snapshots.get(s.date).payload.generatedAt) +
              AVAILABILITY_FRESH_MS,
          ).toISOString()
        : null,
    }));
  }
  return {
    async upcoming(input) {
      if (!upcomingReader)
        throw requestFail(
          "request_unavailable",
          "Session discovery is temporarily unavailable.",
          503,
        );
      const result = await upcomingReader(input);
      return { ...result, sessions: await availability(result.sessions) };
    },
    async sessions(date) {
      calendarDate(date);
      const now = clock();
      return availability(
        (await sessionReader(date)).filter(
          (session) => beirutEnd(session.date, session.endTime) > now,
        ),
      );
    },
    async professionals(date) {
      calendarDate(date);
      return professionalReader(date);
    },
    async submit(input, source, owner) {
      await count(source, "submission-minute", policy.submitMinute);
      await count(source, "submission-hour", policy.submitHour, 3600000);
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Beirut",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(clock());
      const v = intakeInput(input, today),
        id = digest(v.submissionKey),
        payloadDigest = crypto.source(
          digest({
            selection: v.selection,
            patient: v.patient,
            ...(owner ? { owner } : {}),
          }),
        );
      return tx(async (session) => {
        const prior = await requests.findOne({ _id: id }, { session });
        if (prior) {
          alive(prior);
          if (prior.submissionDigest !== payloadDigest)
            throw requestFail(
              "request_retry_conflict",
              "This retry key belongs to different details.",
            );
          if (prior.generation !== 1)
            throw requestFail(
              "request_link_replaced",
              "This tracking link was replaced. Please contact the center; replacements go only to the original submitted phone.",
            );
          return envelope(prior);
        }
        const selected = (await sessionReader(v.selection.date)).find(
          (s) =>
            s.professionalId === v.selection.professionalId &&
            s.sourceSessionId === v.selection.sourceSessionId,
        );
        if (
          !selected ||
          (selected.kind !== "doctor" && selected.kind !== "specialist")
        )
          throw requestFail(
            "session_unavailable",
            "This session is unavailable. Choose another published window.",
          );
        const endsAt = beirutEnd(selected.date, selected.endTime);
        if (
          v.selection.startTime !== undefined &&
          (v.selection.startTime !== selected.startTime ||
            v.selection.endTime !== selected.endTime)
        )
          throw requestFail(
            "session_unavailable",
            "This attendance window changed. Choose the current published session before submitting.",
          );
        if (endsAt <= clock())
          throw requestFail(
            "session_unavailable",
            "This attendance window has ended.",
          );
        const snapshot = await db.collection("website_request_state").findOne(
          {
            _id: `availability:${availabilitySlot(selected.date)}`,
            date: selected.date,
          },
          { session },
        );
        const availabilityState = publicAvailability(
          selected,
          snapshot?.payload,
          clock(),
        );
        if (availabilityState === "full" || availabilityState === "blocked")
          throw requestFail(
            "session_unavailable",
            availabilityState === "full"
              ? "This session is full. Choose another published window."
              : "This session is not currently bookable. Choose another published window.",
          );
        const state = await db
          .collection("website_request_state")
          .findOneAndUpdate(
            { _id: "sequence" },
            { $inc: { value: 1 } },
            { upsert: true, returnDocument: "after", session },
          );
        const token = randomToken(),
          at = clock(),
          phoneKey = crypto.source(v.patient.phone),
          samePhone = await requests.countDocuments(
            { phoneKey, createdAt: { $gte: new Date(at - 86400000) } },
            { session },
          );
        const r = {
          _id: id,
          ...(owner ? { owner } : {}),
          ordinal: state.value,
          reference: `WR-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
          payloadVersion: 1,
          submissionDigest: payloadDigest,
          patient: v.patient,
          language: v.patient.preferredLanguage,
          selection: selected,
          endsAt,
          expiresAt: new Date(endsAt.getTime() + 30 * 86400000),
          createdAt: at,
          phoneKey,
          phoneReview: samePhone >= 4,
          generation: 1,
          tokenHash: digest(token),
          tokenEnvelope: crypto.seal({ token }, `${id}:1`),
          status: "awaiting",
          publicVersion: 0,
          events: [{ status: "awaiting", at }],
        };
        r.payloadDigest = crypto.source(
          digest(
            Object.fromEntries(
              [
                "payloadVersion",
                "reference",
                "ordinal",
                "selection",
                "patient",
                "createdAt",
                "endsAt",
                "expiresAt",
              ].map((k) => [k, r[k]]),
            ),
          ),
        );
        await requests.insertOne(r, { session });
        return envelope(r);
      });
    },
    async profileRequests(owner) {
      const rows = await requests
        .find(
          {
            "owner.accountId": owner.accountId,
            "owner.profileId": owner.profileId,
            purgedAt: { $exists: false },
            expiresAt: { $gt: clock() },
          },
          {
            projection: {
              reference: 1,
              status: 1,
              selection: 1,
              bookingReference: 1,
              reason: 1,
              language: 1,
              endsAt: 1,
              events: 1,
            },
          },
        )
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      return rows.map(bookingDto);
    },
    async cancelProfileRequest(owner, reference, input, authorize) {
      await count(owner.accountId, "cancel-account", 10);
      if (
        typeof reference !== "string" ||
        !/^WR-[A-F0-9]{16}$/u.test(reference)
      )
        throw unavailableCancellation();
      return applyCancellation(
        ownedBy(owner, reference),
        input,
        { channel: "account", ...owner },
        authorize,
      );
    },
    async guestCancellation(proof, source) {
      const { filter, verify } = await guestRow(proof, source);
      const row = await requests.findOne(filter);
      if (!row || row.purgedAt || row.expiresAt <= clock() || !verify(row))
        throw unavailableCancellation();
      const {
        professional,
        specialty,
        date,
        startTime,
        endTime,
        cancellation,
      } = bookingDto(row);
      return {
        professional,
        specialty,
        date,
        startTime,
        endTime,
        cancellation,
      };
    },
    async cancelGuestRequest(proof, source, input) {
      const { filter, verify } = await guestRow(proof, source);
      return applyCancellation(
        filter,
        input,
        { channel: "guest_link" },
        verify,
      );
    },
    async track(token, source) {
      await count(source, "tracking-source", policy.trackingSource);
      secret(token);
      const r = await requests.findOne({ tokenHash: digest(token) });
      alive(r);
      await count(r._id, "tracking-token", policy.trackingToken);
      return {
        ...publicRequest(r, clock(), { localReviewOnly }),
        ...guestCancellationLink(r),
      };
    },
    async pull(cursor = 0) {
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw requestFail("request_input", "Invalid intake cursor.", 400);
      const rows = await requests
        .find(
          {
            ordinal: { $gt: cursor },
            purgedAt: { $exists: false },
            expiresAt: { $gt: clock() },
          },
          { projection },
        )
        .sort({ ordinal: 1 })
        .limit(25)
        .maxTimeMS(2000)
        .toArray();
      const patientCancellations = (
        await requests
          .find(
            { cancellationSyncPending: true, purgedAt: { $exists: false } },
            { projection: { patientCancellation: 1 } },
          )
          .sort({ ordinal: 1 })
          .limit(25)
          .toArray()
      ).map((row) => ({
        requestId: row._id,
        at: row.patientCancellation.at,
        channel: row.patientCancellation.channel,
        reasons: row.patientCancellation.reasons,
      }));
      return {
        schemaVersion: 1,
        requests: rows.map(({ owner, ...row }) => ({
          ...row,
          ...(!owner ? { guestCancellationExpiresAt: guestExpiry(row) } : {}),
        })),
        cursor: rows.at(-1)?.ordinal ?? cursor,
        ...(patientCancellations.length ? { patientCancellations } : {}),
        availabilityDates: (
          await db
            .collection("website_request_state")
            .find({
              kind: "availability-demand",
              requestedAt: { $gt: new Date(clock().getTime() - 120000) },
            })
            .limit(64)
            .toArray()
        ).map((row) => row.date),
      };
    },
    async acceptAvailability(input) {
      try {
        validateAvailability(input);
      } catch {
        throw requestFail("request_input", "Invalid availability update.", 400);
      }
      if (Date.parse(input.generatedAt) > clock().getTime() + 10000)
        throw requestFail(
          "request_input",
          "Invalid availability timestamp.",
          400,
        );
      return tx(async (session) => {
        const states = db.collection("website_request_state"),
          id = `availability:${availabilitySlot(input.date)}`;
        const previous = await states.findOne({ _id: id }, { session });
        if (previous?.payload.sequence >= input.sequence) {
          if (
            previous.payload.sequence === input.sequence &&
            previous.payload.digest !== input.digest
          )
            throw requestFail(
              "request_conflict",
              "Availability version conflict.",
            );
          return {
            accepted: true,
            ...(previous.payload.sequence > input.sequence
              ? { obsolete: true }
              : {}),
            sequence: previous.payload.sequence,
            digest: previous.payload.digest,
          };
        }
        await states.updateOne(
          { _id: id },
          { $set: { date: input.date, payload: input } },
          { session, upsert: true },
        );
        return {
          accepted: true,
          sequence: input.sequence,
          digest: input.digest,
        };
      });
    },
    async accept(event) {
      if (event?.patientCancelled === true) {
        exact(event, ["requestId", "patientCancelled"]);
        if (
          typeof event.requestId !== "string" ||
          !/^[a-f0-9]{64}$/u.test(event.requestId)
        )
          throw unavailableCancellation();
        await sendPatientCancellationEmail(event.requestId).catch(() => {});
        await requests.updateOne(
          { _id: event.requestId, status: "cancelled_by_patient" },
          { $unset: { cancellationSyncPending: "" } },
        );
        return { accepted: true, patientCancelled: true };
      }
      exact(event, [
        "requestId",
        "sequence",
        "status",
        "reason",
        "bookingReference",
        "at",
        "digest",
      ]);
      if (
        !/^[a-f0-9]{64}$/.test(event.requestId) ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        !["confirmed", "rejected", "cancelled"].includes(event.status) ||
        !(
          event.reason === null || Object.hasOwn(REQUEST_REASONS, event.reason)
        ) ||
        !Number.isFinite(Date.parse(event.at)) ||
        !(
          event.bookingReference === null ||
          /^B-\d{8,16}$/.test(event.bookingReference)
        )
      )
        throw requestFail("request_input", "Invalid tracking update.", 400);
      const { digest: claimed, ...body } = event;
      if (
        digest(body) !== claimed ||
        (event.status !== "confirmed" && !event.reason) ||
        (event.status === "confirmed" && !event.bookingReference)
      )
        throw requestFail("request_input", "Invalid tracking update.", 400);
      return tx(async (session) => {
        const r = await requests.findOne({ _id: event.requestId }, { session });
        alive(r);
        if (r.status === "cancelled_by_patient")
          return { accepted: true, sequence: event.sequence, digest: claimed };
        if (event.sequence < r.publicVersion)
          return {
            accepted: true,
            obsolete: true,
            sequence: r.publicVersion,
            digest: r.lastDigest,
          };
        if (event.sequence === r.publicVersion) {
          if (r.lastDigest !== claimed)
            throw requestFail(
              "request_sync_conflict",
              "Tracking version conflict.",
            );
          return { accepted: true, sequence: r.publicVersion, digest: claimed };
        }
        if (
          r.status !== "awaiting" &&
          event.status !== r.status &&
          !(r.status === "confirmed" && event.status === "cancelled")
        )
          throw requestFail(
            "request_sync_conflict",
            "Tracking transition conflict.",
          );
        await requests.updateOne(
          { _id: r._id },
          {
            $set: {
              status: event.status,
              reason: event.reason,
              bookingReference: event.bookingReference,
              publicVersion: event.sequence,
              lastDigest: claimed,
            },
            $push: {
              events: {
                status: event.status,
                at: new Date(event.at),
                ...(event.reason ? { reason: event.reason } : {}),
              },
            },
          },
          { session },
        );
        return { accepted: true, sequence: event.sequence, digest: claimed };
      });
    },
    async rotate(input) {
      exact(input, ["requestId", "generation", "key"]);
      text(input.requestId, 64);
      secret(input.key);
      if (!Number.isSafeInteger(input.generation) || input.generation < 1)
        throw requestFail("request_input", "Invalid link request.", 400);
      return tx(async (session) => {
        const r = await requests.findOne({ _id: input.requestId }, { session });
        alive(r);
        if (r.rotationKey === digest(input.key))
          return {
            requestId: r._id,
            generation: r.generation,
            tokenEnvelope: r.tokenEnvelope,
          };
        if (r.generation !== input.generation)
          throw requestFail("request_stale", "This link was already replaced.");
        const generation = r.generation + 1,
          token = randomToken(),
          tokenEnvelope = crypto.seal({ token }, `${r._id}:${generation}`);
        await requests.updateOne(
          { _id: r._id },
          {
            $set: {
              generation,
              tokenHash: digest(token),
              tokenEnvelope,
              rotationKey: digest(input.key),
            },
          },
          { session },
        );
        return { requestId: r._id, generation, tokenEnvelope };
      });
    },
    async cleanup({ apply = false } = {}) {
      const now = clock();
      const eligible = await requests.countDocuments({
        expiresAt: { $lte: now },
        purgedAt: { $exists: false },
      });
      if (apply)
        await requests.updateMany(
          { expiresAt: { $lte: now }, purgedAt: { $exists: false } },
          {
            $unset: {
              patient: "",
              tokenHash: "",
              tokenEnvelope: "",
              phoneKey: "",
              selection: "",
              events: "",
              rotationKey: "",
              submissionDigest: "",
            },
            $set: { purgedAt: now },
          },
        );
      if (apply)
        await requests.deleteMany({
          purgedAt: { $exists: true },
          endsAt: { $lte: new Date(now - 90 * 86400000) },
        });
      return { eligible, applied: apply };
    },
  };
}
