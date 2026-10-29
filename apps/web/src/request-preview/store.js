import { useSyncExternalStore } from "react";
import { SAMPLE_PATIENT, SESSIONS, REASONS } from "./model.js";

const at = () => new Date().toISOString();
export function seedPreview() {
  const requests = ["awaiting", "confirmed", "rejected"].map((status, i) => {
    const created = `2026-10-28T08:${String(i + 10).padStart(2, "0")}:00.000Z`;
    return {
      id: `demo:request:${i + 1}`,
      reference: `WR-DEMO-000${i + 1}`,
      trackingToken: `demo-not-a-secret-${i + 1}`,
      patient: {
        ...SAMPLE_PATIENT,
        firstName: ["Synthetic", "Example", "Preview"][i],
        preferredLanguage: i === 1 ? "ar" : "en",
      },
      session: SESSIONS[i],
      status,
      publicStatus: status,
      bookingReference: status === "confirmed" ? "B-DEMO-001" : null,
      publicBookingReference: status === "confirmed" ? "B-DEMO-001" : null,
      reason: status === "rejected" ? "details_check" : null,
      publicReason: status === "rejected" ? "details_check" : null,
      publicEvents: [
        { status: "awaiting", at: created },
        ...(status !== "awaiting"
          ? [
              {
                status,
                at: "2026-10-28T08:40:00.000Z",
                ...(status === "rejected" ? { reason: "details_check" } : {}),
              },
            ]
          : []),
      ],
      events:
        status === "awaiting"
          ? []
          : [
              {
                status,
                at: "2026-10-28T08:40:00.000Z",
                ...(status === "rejected" ? { reason: "details_check" } : {}),
              },
            ],
      version: 1,
      publicVersion: 1,
      imported: true,
      notes:
        "Synthetic staff-only note. Never included in guest tracking or messages.",
      linkedPatientId: status === "confirmed" ? "demo:patient:one" : null,
      matchAcknowledged: false,
      staffHistory: [],
      createdAt: created,
    };
  });
  const phone = {
    ...requests[1],
    id: "demo:phone-booking",
    source: "phone",
    reference: "B-DEMO-PHONE-001",
    bookingReference: "B-DEMO-PHONE-001",
    trackingToken: undefined,
    patient: {
      ...SAMPLE_PATIENT,
      firstName: "Phoneexample",
      preferredLanguage: "en",
    },
  };
  requests.push(phone);
  return {
    requests,
    notices: [
      {
        id: "demo:notice:2:1",
        requestId: requests[1].id,
        version: 1,
        status: "pending",
        language: "ar",
        history: [],
      },
      {
        id: "demo:notice:3:1",
        requestId: requests[2].id,
        version: 1,
        status: "call_required",
        language: "en",
        history: [],
      },
      {
        id: "demo:phone-notice",
        requestId: phone.id,
        version: 1,
        status: "pending",
        language: "en",
        history: [],
      },
    ],
    revision: 0,
    syncAvailable: true,
    fixtureOnly: true,
  };
}
export function createPreviewStore(channel) {
  let state = seedPreview();
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());
  function publish(next) {
    state = { ...next, revision: Math.max(Date.now(), state.revision + 1) };
    emit();
    channel?.postMessage({ kind: "preview-state", state });
  }
  if (channel) {
    channel.onmessage = ({ data }) => {
      if (data?.kind === "preview-hello")
        channel.postMessage({ kind: "preview-state", state });
      else if (
        data?.kind === "preview-state" &&
        data.state?.fixtureOnly === true &&
        data.state.revision > state.revision
      ) {
        state = data.state;
        emit();
      }
    };
    channel.postMessage({ kind: "preview-hello" });
  }
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    reset() {
      publish(seedPreview());
    },
    setSync(value) {
      publish({ ...state, syncAvailable: value });
    },
    submit(patient, session, key) {
      const prior = state.requests.find((r) => r.submitKey === key);
      if (prior) return prior;
      const index = state.requests.length + 1;
      const request = {
        id: `demo:request:${index}`,
        reference: `WR-DEMO-${String(index).padStart(4, "0")}`,
        trackingToken: `demo-not-a-secret-${index}`,
        submitKey: key,
        patient: { ...patient },
        session,
        status: "awaiting",
        publicStatus: "awaiting",
        publicEvents: [{ status: "awaiting", at: at() }],
        events: [],
        imported: false,
        notes: "",
        linkedPatientId: null,
        matchAcknowledged: false,
        staffHistory: [],
        version: 1,
        publicVersion: 1,
        createdAt: at(),
      };
      publish({ ...state, requests: [...state.requests, request] });
      return request;
    },
    pull() {
      publish({
        ...state,
        requests: state.requests.map((r) => ({ ...r, imported: true })),
      });
    },
    patch(id, changes) {
      publish({
        ...state,
        requests: state.requests.map((r) =>
          r.id === id ? { ...r, ...changes } : r,
        ),
      });
    },
    decide(
      id,
      status,
      reason,
      actor = "Synthetic Receptionist",
      expectedVersion,
      existingBooking,
    ) {
      const r = state.requests.find((v) => v.id === id);
      if (
        !r ||
        (status === "cancelled"
          ? r.status !== "confirmed"
          : r.status !== "awaiting")
      )
        throw Error("This preview request changed. Reload its current state.");
      if (expectedVersion !== undefined && expectedVersion !== r.version)
        throw Error(
          "This preview request changed. Review the current details before deciding.",
        );
      if (
        status === "confirmed" &&
        (!r.linkedPatientId || !r.matchAcknowledged)
      )
        throw Error(
          "Link or create a synthetic patient and acknowledge the reviewed details first.",
        );
      if (status !== "confirmed" && !Object.hasOwn(REASONS, reason ?? ""))
        throw Error("Choose a fixed patient-facing reason.");
      const next = {
        ...r,
        status,
        reason: reason || null,
        version: r.version + 1,
        ...(status === "confirmed"
          ? {
              bookingReference:
                existingBooking ??
                `B-DEMO-${String(state.requests.filter((v) => v.bookingReference).length + 1).padStart(3, "0")}`,
            }
          : {}),
        events: [
          ...r.events,
          { status, at: at(), ...(reason ? { reason } : {}) },
        ],
        staffHistory: [
          ...r.staffHistory,
          {
            action: existingBooking ? "Existing booking reconciled" : status,
            actor,
            at: at(),
          },
        ],
      };
      const notices = state.notices.map((n) =>
        n.requestId === id && ["pending", "call_required"].includes(n.status)
          ? { ...n, status: "superseded" }
          : n,
      );
      notices.push({
        id: `demo:notice:${id}:${next.version}`,
        requestId: id,
        version: next.version,
        status: "pending",
        language: r.patient.preferredLanguage,
        history: [],
      });
      publish({
        ...state,
        requests: state.requests.map((v) => (v.id === id ? next : v)),
        notices,
      });
      if (state.syncAvailable) this.sync(id);
    },
    sync(id) {
      if (!state.syncAvailable)
        throw Error(
          "Simulated public delivery unavailable. Local decision is retained; guest tracking keeps its last synchronized status.",
        );
      publish({
        ...state,
        requests: state.requests.map((r) =>
          r.id === id
            ? {
                ...r,
                publicStatus: r.status,
                publicVersion: r.version,
                publicReason: r.reason,
                publicBookingReference: r.bookingReference,
                publicEvents: [
                  r.publicEvents[0],
                  ...r.events.map(({ status, at, reason }) => ({
                    status,
                    at,
                    ...(reason ? { reason } : {}),
                  })),
                ],
              }
            : r,
        ),
      });
    },
    notice(id, status, actor, outcome) {
      const notice = state.notices.find((n) => n.id === id),
        r = state.requests.find((r) => r.id === notice?.requestId);
      if (
        !notice ||
        !r ||
        notice.version !== r.version ||
        notice.status === "superseded"
      )
        throw Error(
          "This notice is outdated. Open the current notice; nothing was sent.",
        );
      publish({
        ...state,
        notices: state.notices.map((n) =>
          n.id === id
            ? {
                ...n,
                status,
                history: [
                  ...n.history,
                  { status, actor, at: at(), ...(outcome ? { outcome } : {}) },
                ],
              }
            : n,
        ),
      });
    },
  };
}
const channel =
  typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("cedar-visual-preview-only")
    : null;
export const previewStore = createPreviewStore(channel);
export const usePreview = () =>
  useSyncExternalStore(
    previewStore.subscribe,
    previewStore.getSnapshot,
    previewStore.getSnapshot,
  );
