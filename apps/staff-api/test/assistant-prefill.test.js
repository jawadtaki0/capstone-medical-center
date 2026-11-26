import { test } from "node:test";
import assert from "node:assert/strict";
import { readPrefill } from "../src/assistant/prefill.js";

const today = "2026-11-26"; // a Thursday

test("reads names, birth date and session date from English", () => {
  assert.deepEqual(
    readPrefill("book Sami Haddad born 1988-07-04 on monday", today),
    {
      firstName: "Sami",
      lastName: "Haddad",
      dateOfBirth: "1988-07-04",
      date: "2026-11-30",
    },
  );
  assert.deepEqual(
    readPrefill(
      "I want to book an appointment for Lina Khoury, DOB 12/03/1995, tomorrow with Dr. Karim",
      today,
    ),
    {
      firstName: "Lina",
      lastName: "Khoury",
      dateOfBirth: "1995-03-12",
      date: "2026-11-27",
    },
  );
});

test("reads names and dates from Arabic", () => {
  assert.deepEqual(
    readPrefill("احجز للمريض سامي حداد مواليد ٤/٧/١٩٨٨ يوم الاثنين", today),
    {
      firstName: "سامي",
      lastName: "حداد",
      dateOfBirth: "1988-07-04",
      date: "2026-11-30",
    },
  );
});

test("reads the patient and booking numbers", () => {
  assert.equal(
    readPrefill("cancel the booking B-00000007", today).bookingNumber,
    "B-00000007",
  );
  assert.equal(
    readPrefill("book patient P-00000003 tomorrow", today).patientNumber,
    "P-00000003",
  );
});

test("a question without details pre-fills nothing", () => {
  for (const text of [
    "how do I book an appointment",
    "كيف بحجز موعد لمريض",
    "how do I book for a new patient",
  ])
    assert.deepEqual(readPrefill(text, today), {}, text);
});
