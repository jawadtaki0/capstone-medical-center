import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROFESSIONALS,
  SESSIONS,
  SAMPLE_PATIENT,
  publicTracking,
  notificationText,
  validateDetails,
  matchCandidates,
} from "../src/request-preview/model.js";
import { createPreviewStore } from "../src/request-preview/store.js";

test("unavailable tracking explains approved original-phone replacement without public identity lookup", () => {
  const text = readFileSync(
    new URL("../src/request-preview/TrackingView.jsx", import.meta.url),
    "utf8",
  );
  assert.equal(text.includes("Link-reissue policy is pending approval"), false);
  assert.equal(text.includes("سياسة استبدال الرابط بانتظار الاعتماد"), false);
  assert.ok(
    text.includes(
      "Contact the center's staff about a replacement. It can be delivered only to the phone originally submitted with this request.",
    ),
  );
  assert.ok(
    text.includes(
      "Knowing a name or reference does not provide access or establish identity.",
    ),
  );
  assert.ok(
    text.includes(
      "تواصل مع موظفي المركز لطلب استبدال الرابط. لا يُرسل البديل إلا إلى رقم الهاتف المُقدَّم أصلًا مع هذا الطلب.",
    ),
  );
  assert.ok(
    text.includes("معرفة الاسم أو رقم المرجع لا تتيح الوصول ولا تثبت الهوية."),
  );
});

test("synthetic selection has doctors and specialists but no private capacity or service booking", () => {
  assert.ok(PROFESSIONALS.some((p) => p.kind === "specialist"));
  for (const s of SESSIONS) {
    assert.ok(PROFESSIONALS.some((p) => p.id === s.professionalId));
    assert.equal(Object.hasOwn(s, "capacity"), false);
    assert.equal(Object.hasOwn(s, "remaining"), false);
  }
});
test("required details reuse patient validation, accept Arabic names/shared phone, and retain maternal first-name meaning", () => {
  assert.deepEqual(validateDetails(SAMPLE_PATIENT), {});
  for (const key of Object.keys(SAMPLE_PATIENT))
    assert.ok(
      Object.hasOwn(validateDetails({ ...SAMPLE_PATIENT, [key]: "" }), key),
    );
  assert.deepEqual(
    validateDetails({
      ...SAMPLE_PATIENT,
      firstName: "سارة",
      fatherName: "علي",
      lastName: "سالم",
      motherFirstName: "منى",
      preferredLanguage: "ar",
    }),
    {},
  );
  assert.ok(
    validateDetails({ ...SAMPLE_PATIENT, dateOfBirth: "2030-01-01" })
      .dateOfBirth,
  );
  assert.equal(
    matchCandidates(SAMPLE_PATIENT)[0].classification,
    "Strong candidate",
  );
});
test("tracking is an explicit allowlist and excludes submitted identity, phone and staff notes", () => {
  const r = createPreviewStore().getSnapshot().requests[0];
  const publicValue = publicTracking(r),
    encoded = JSON.stringify(publicValue);
  for (const text of [
    r.patient.firstName,
    r.patient.motherFirstName,
    r.patient.phone,
    r.patient.dateOfBirth,
    r.notes,
  ])
    assert.equal(encoded.includes(text), false);
  assert.deepEqual(
    Object.keys(publicValue).sort(),
    [
      "reference",
      "status",
      "professional",
      "date",
      "startTime",
      "endTime",
      "bookingReference",
      "reason",
      "language",
      "events",
    ].sort(),
  );
});
test("memory-only request submission is retry-stable and never automatically links or confirms", () => {
  const store = createPreviewStore();
  const first = store.submit(SAMPLE_PATIENT, SESSIONS[0], "demo-key");
  assert.equal(
    store.submit(SAMPLE_PATIENT, SESSIONS[0], "demo-key").id,
    first.id,
  );
  assert.equal(first.status, "awaiting");
  assert.equal(first.linkedPatientId, null);
  assert.equal(first.imported, false);
  store.pull();
  store.pull();
  assert.equal(
    store.getSnapshot().requests.filter((r) => r.id === first.id).length,
    1,
  );
});
test("simulated local decision survives paused sync; tracking advances only when explicitly synchronized", () => {
  const store = createPreviewStore(),
    r = store.getSnapshot().requests[0];
  store.setSync(false);
  assert.throws(() => store.decide(r.id, "confirmed"), /Link or create/);
  store.patch(r.id, {
    linkedPatientId: "demo:patient:one",
    matchAcknowledged: true,
  });
  store.decide(r.id, "confirmed", null, "Synthetic Admin", 1);
  let current = store.getSnapshot().requests[0];
  assert.equal(current.status, "confirmed");
  assert.equal(publicTracking(current).status, "awaiting");
  assert.throws(() => store.sync(r.id), /unavailable/);
  store.setSync(true);
  store.sync(r.id);
  current = store.getSnapshot().requests[0];
  assert.equal(publicTracking(current).status, "confirmed");
  assert.equal(publicTracking(current).events.length, 2);
});
test("fixed reasons and stale notices demonstrate private cancellation without free-text public details", () => {
  const store = createPreviewStore(),
    r = store.getSnapshot().requests[1],
    n = store.getSnapshot().notices[0];
  store.notice(n.id, "opened", "Synthetic Admin");
  assert.throws(
    () => store.decide(r.id, "cancelled", "private medical text"),
    /fixed/,
  );
  store.decide(r.id, "cancelled", "session_unavailable", "Synthetic Admin", 1);
  assert.throws(
    () => store.notice(n.id, "sent", "Synthetic Admin"),
    /outdated/,
  );
  assert.equal(store.getSnapshot().notices[0].history.length, 1);
  const track = publicTracking(store.getSnapshot().requests[1]);
  assert.equal(track.reason, "session_unavailable");
  assert.equal(track.status, "cancelled");
});
test("Arabic/English fixed message excludes sensitive attributes and does not promise an exact time", () => {
  const r = createPreviewStore().getSnapshot().requests[1];
  for (const language of ["en", "ar"]) {
    const text = notificationText(r, language);
    for (const value of [
      r.patient.motherFirstName,
      r.patient.dateOfBirth,
      "P-DEMO",
      r.notes,
    ])
      assert.equal(text.includes(value), false);
    assert.ok(text.includes(r.session.startTime));
  }
  assert.ok(
    notificationText(r, "en").includes(
      "This is your attendance window. Consultation order follows check-in. Please report to reception on arrival.",
    ),
  );
  assert.ok(notificationText(r, "ar").includes("تسجيل الحضور"));
});
test("normal entries do not import previews; preview has no fetch/provider/openExternal/storage access", () => {
  const main = readFileSync(
    new URL("../src/main.jsx", import.meta.url),
    "utf8",
  );
  assert.equal(main.includes("request-preview"), false);
  for (const file of [
    "store.js",
    "RequestForm.jsx",
    "RequestInbox.jsx",
    "NotificationPreview.jsx",
  ]) {
    const text = readFileSync(
      new URL(`../src/request-preview/${file}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      /\bfetch\s*\(|shell\.openExternal|window\.open\s*\(|localStorage|sessionStorage/.test(
        text,
      ),
      false,
      file,
    );
  }
});

test("manual notices use approved name/title/date/bold status and bilingual center branding", () => {
  const store = createPreviewStore();
  const request = store
    .getSnapshot()
    .requests.find((r) => r.status === "confirmed");
  const english = notificationText(request, "en"),
    arabic = notificationText(request, "ar");
  assert.ok(
    english.startsWith(
      `Name: ${request.patient.firstName} ${request.patient.fatherName} ${request.patient.lastName}\nDr: `,
    ),
  );
  assert.ok(english.includes("\n*CONFIRMED*\nThis is your attendance window."));
  assert.ok(english.endsWith("Cedar Medical Center CMC"));
  assert.ok(arabic.includes("\nد.: "));
  assert.ok(arabic.includes("\n*مؤكد*\nهذه فترة الحضور."));
  assert.ok(arabic.endsWith("مركز سيدر للخدمات الطبية CMC"));
  assert.ok(
    arabic.includes(
      `\u2066${request.session.startTime}–${request.session.endTime}\u2069`,
    ),
  );
  const specialist = {
    ...request,
    session: SESSIONS.find((s) => s.professionalId === "demo:specialist:nour"),
  };
  assert.ok(
    notificationText(specialist, "en").includes("\nSpecialist: Nour Demo\n"),
  );
  assert.equal(notificationText(specialist, "ar").includes("\nد."), false);
});
