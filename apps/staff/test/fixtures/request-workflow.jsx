import React from "react";
import { createRoot } from "react-dom/client";
import Requests from "../../src/components/WebsiteRequests.jsx";
import RequestNoticeDialog, {
  BookingNoticeButton,
} from "../../src/components/RequestNoticeDialog.jsx";
import "../../src/styles.css";

const params = new URLSearchParams(location.search),
  patient = {
    firstName: "Synthetic",
    fatherName: "Father",
    lastName: "Example",
    motherFirstName: "Mother",
    dateOfBirth: "2000-01-01",
    phone: "+96171123456",
    gender: "female",
  };
let request = {
    id: "request",
    reference: "WR-SYNTHETIC",
    revision: 1,
    status: "awaiting",
    patient,
    scopeId: "clinic",
    selection: {
      professionalName: "Synthetic Doctor",
      date: "2026-11-02",
      startTime: "09:00",
      endTime: "11:00",
      sourceSessionId: "session",
    },
    sequence: 1,
    syncedSequence: 1,
  },
  candidates = params.has("candidate")
    ? [{ ...patient, id: "patient", revision: 2, classification: "strong" }]
    : [],
  noticeState = "pending";
window.calls = [];
window.resolved = 0;
const api = {
  websiteRequests: async (input) => {
    window.calls.push(structuredClone(input));
    if (input.action === "list" && params.has("heldInitial"))
      await new Promise((resolve) => {
        window.releaseList = resolve;
      });
    if (input.action === "list" && params.has("slowInitial"))
      await new Promise((resolve) => setTimeout(resolve, 10000));
    if (["list", "notices"].includes(input.action) && params.has("delayed"))
      await new Promise((resolve) =>
        setTimeout(resolve, input.action === "list" ? 900 : 120),
      );
    if (["list", "notices"].includes(input.action) && params.has("failure"))
      throw Error("Synthetic list unavailable. Retry safely.");
    if (input.action === "list")
      return {
        requests: params.has("empty") ? [] : [request],
        nextCursor: null,
      };
    if (input.action === "notices")
      return {
        notices: [
          { id: "notice", state: "pending", createdAt: "2026-11-02T10:00:00Z" },
        ],
        nextCursor: null,
      };
    if (input.action === "detail")
      return {
        request: structuredClone(request),
        matches: { candidates, hasMore: false, reviewDigest: "digest" },
        notices: [],
        audit: [],
        existingBookings: [],
      };
    if (input.action === "review")
      return {
        patient: request.linkedPatientId
          ? { id: "patient", revision: 2 }
          : { ...patient, id: null },
        ...(request.linkedPatientId
          ? {}
          : { patientCreation: { mode: "create_if_unmatched" } }),
        session: {
          date: request.selection.date,
          capacity: 3,
          remaining: 3,
          version: "version",
          startTime: "09:00",
          endTime: "11:00",
        },
        overlaps: [],
      };
    if (input.action === "link") {
      request.linkedPatientId = input.patientId;
      request.revision++;
      return {};
    }
    if (input.action === "confirm") {
      if (params.has("race")) {
        candidates = [
          {
            ...patient,
            id: "new-patient",
            revision: 1,
            classification: "strong",
          },
        ];
        const e = Error(
          "A patient match appeared. Review the current candidates before confirming.",
        );
        e.code = "request_patient_review";
        throw e;
      }
      request.status = "confirmed";
      request.bookingReference = "B-SYNTHETIC";
      request.revision++;
      return {};
    }
    if (input.action === "bookingNoticeLookup") return { noticeId: "notice" };
    if (input.action === "notification") {
      if (input.noticeAction === "preview") {
        if (params.has("delay"))
          await new Promise((resolve) => setTimeout(resolve, 180));
        return {
          localReviewOnly: true,
          message: "Synthetic message\n*CONFIRMED*",
          notice: { state: noticeState, history: [] },
          stale: false,
        };
      }
      if (input.noticeAction === "sent") noticeState = "sent";
      return {};
    }
    return {};
  },
  openRequestWhatsApp: async (input) => {
    window.calls.push({ action: "external_mock", ...input });
    if (params.has("openFailure"))
      throw Error("Synthetic opening failure. Nothing was marked sent.");
    noticeState = "opened";
    return { opened: true };
  },
};
const onResolved = () => window.resolved++;
createRoot(document.getElementById("root")).render(
  <>
    {params.has("heldInitial") && (
      <button onClick={() => window.releaseList?.()}>
        Release delayed list
      </button>
    )}
    {params.has("booking") ? (
      <BookingNoticeButton
        api={api}
        bookingId="booking"
        onChanged={onResolved}
      />
    ) : params.has("notice") ? (
      <RequestNoticeDialog
        api={api}
        noticeId="notice"
        onClose={() => document.getElementById("root").replaceChildren()}
        onChanged={onResolved}
      />
    ) : (
      <Requests
        api={api}
        initialRequestId={params.has("initial") ? "request" : undefined}
        onResolved={onResolved}
      />
    )}
  </>,
);
