import { readFileSync } from "node:fs";
import { StaffError } from "./errors.js";
import {
  normalizedEmail,
  canonicalPhone,
  phoneNumber,
  EMAIL_INPUT_MESSAGE,
  PHONE_INPUT_MESSAGE,
} from "../../staff/shared/contact-input.js";

const invalid = (message) => new StaffError("invalid_input", message);
const blockedPasswords = new Set([
  "",
  "passwordpassword",
  "password123456789",
  "123456789012345",
  "1234567890123456",
  "qwertyuiopasdfgh",
  "this is a password",
  "this is my password",
  "letmeinletmeinletmein",
  "cedar medical center",
  "cedar staff admin",
  "medical center admin",
  "admin admin admin",
  ...readFileSync(
    new URL("./data/common-passwords.txt", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean),
  ...readFileSync(
    new URL("./data/common-short-passwords.txt", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean),
]);
const passwordComparison = (value) =>
  value.normalize("NFKC").trim().toLowerCase();
const compactContext = (value) =>
  passwordComparison(value).replace(/[\s._-]+/gu, "");
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function predictableContextPassword(value, username) {
  const candidate = compactContext(value);
  const bases = [
    "cedar",
    "cedar staff",
    "cedar medical center",
    "cedar staff admin",
    "medical center admin",
  ];
  if (typeof username === "string" && username.trim()) bases.push(username);
  // Match complete predictable phrases (including simple numeric/punctuation
  // decoration and repetitions), never words embedded in a longer passphrase.
  return bases
    .map(compactContext)
    .filter(Boolean)
    .some((base) =>
      new RegExp(
        `^[0-9!@#$%^&*?]*(?:${escapePattern(base)})+[0-9!@#$%^&*?]*$`,
        "u",
      ).test(candidate),
    );
}

export function normalizeUsername(value) {
  if (typeof value !== "string") throw invalid("Enter your assigned username.");
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw invalid(
      "Use a username of 3–40 letters, numbers, periods, underscores or hyphens.",
    );
  }
  return username;
}

export function validatePassword(value, context = {}) {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 15 ||
    Array.from(value).length > 128
  ) {
    throw invalid(
      "Choose a passphrase of 15–128 characters. Spaces are allowed.",
    );
  }
  if (
    blockedPasswords.has(passwordComparison(value)) ||
    predictableContextPassword(value, context?.username)
  ) {
    throw invalid(
      "Choose a less common passphrase that is not the center or account name.",
    );
  }
  return value; // Do not trim, normalize or truncate the actual password.
}

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function text(value, label, maximum = 160) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value.trim()).length > maximum
  ) {
    throw invalid(`Enter ${label} (up to ${maximum} characters).`);
  }
  return value.trim();
}

export function validateProfile(
  value,
  today = new Date().toISOString().slice(0, 10),
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("Complete the staff profile.");
  const departments = value.departments;
  if (
    !Array.isArray(departments) ||
    !departments.length ||
    new Set(departments).size !== departments.length ||
    departments.some(
      (department) =>
        !["Clinic", "Laboratory", "Administration"].includes(department),
    )
  ) {
    throw invalid(
      "Choose at least one valid department; do not repeat a department.",
    );
  }
  if (!validDate(value.dateOfBirth) || value.dateOfBirth > today)
    throw invalid("Enter a valid date of birth that is not in the future.");
  if (!validDate(value.employmentStartDate))
    throw invalid("Enter a valid employment start date.");
  const email = normalizedEmail(value.email);
  if (!email) throw invalid(EMAIL_INPUT_MESSAGE);
  const phone = canonicalPhone(value.phone, "LB");
  if (!phone) throw invalid(PHONE_INPUT_MESSAGE);
  const qualification = value.qualification;
  if (!qualification || qualification.type !== "university")
    throw invalid(
      "The first Admin requires a relevant university qualification.",
    );
  const cleanQualification = {
    type: "university",
    title: text(qualification.title, "the qualification title"),
    institution: text(qualification.institution, "the awarding institution"),
  };
  if (qualification.level !== undefined)
    cleanQualification.level = text(
      qualification.level,
      "the qualification level",
      80,
    );
  return {
    firstName: text(value.firstName, "a first name", 80),
    lastName: text(value.lastName, "a last name", 80),
    fatherName: text(value.fatherName, "the father's given name", 80),
    motherName: text(value.motherName, "the mother's given name", 80),
    dateOfBirth: value.dateOfBirth,
    address: text(value.address, "an address", 400),
    phone,
    phoneCountry: phoneNumber(phone).country,
    email,
    emailVerified: false,
    departments: [...departments],
    employmentStartDate: value.employmentStartDate,
    qualification: cleanQualification,
  };
}

export function boundedSecret(value, maximum = 128) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : "";
}
