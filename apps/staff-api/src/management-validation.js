import { StaffError } from "./errors.js";
import { requiresMfa, validRoles } from "./permissions.js";
import { normalizeUsername, validDate } from "./validation.js";
import {
  normalizedEmail,
  canonicalPhone,
  EMAIL_INPUT_MESSAGE,
  PHONE_INPUT_MESSAGE,
} from "../../staff/shared/contact-input.js";

export const DEPARTMENTS = Object.freeze([
  "Clinic",
  "Laboratory",
  "Administration",
]);
export const PROFILE_FIELDS = Object.freeze([
  "firstName",
  "lastName",
  "fatherName",
  "motherName",
  "dateOfBirth",
  "address",
  "phone",
  "email",
  "departments",
  "employmentStartDate",
  "qualification",
]);
export const EDITABLE_PROFILE_FIELDS = Object.freeze(
  PROFILE_FIELDS.filter((field) => field !== "email"),
);
export const CONTACT_FIELDS = Object.freeze(["address", "phone"]);
const qualificationTypes = new Set([
  "university",
  "technical_vocational",
  "general_baccalaureate",
]);
const invalid = (message) => new StaffError("invalid_input", message);

export function allowFields(value, fields, label = "request") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid(`Send a valid ${label}.`);
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw invalid(`The ${label} contains a field that cannot be changed here.`);
  return value;
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

export function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 0)
    throw invalid("Include the current profile revision.");
  return value;
}

export function expectedVersion(value) {
  if (!Number.isInteger(value) || value < 1)
    throw invalid("Include the current account version.");
  return value;
}

export function validateRoles(value) {
  if (!validRoles(value))
    throw invalid(
      "Select at least one of the six staff roles without duplicates.",
    );
  return [...value];
}

function sameQualification(left, right) {
  return (
    right &&
    ["type", "title", "institution", "level"].every(
      (field) => left[field] === right[field],
    )
  );
}

export function validateManagementProfile(
  value,
  roles,
  today,
  { legacyQualification, legacyContacts } = {},
) {
  allowFields(value, PROFILE_FIELDS, "staff profile");
  validateRoles(roles);
  if (!validDate(value.dateOfBirth) || value.dateOfBirth > today)
    throw invalid("Enter a valid date of birth that is not in the future.");
  if (!validDate(value.employmentStartDate))
    throw invalid("Enter a valid employment start date.");
  if (
    !Array.isArray(value.departments) ||
    !value.departments.length ||
    new Set(value.departments).size !== value.departments.length ||
    value.departments.some((department) => !DEPARTMENTS.includes(department))
  )
    throw invalid("Choose valid departments without duplicates.");
  const unchangedEmail = legacyContacts && value.email === legacyContacts.email;
  const email = unchangedEmail ? value.email : normalizedEmail(value.email);
  if (!unchangedEmail && !email) throw invalid(EMAIL_INPUT_MESSAGE);
  const unchangedPhone = legacyContacts && value.phone === legacyContacts.phone;
  const phone = unchangedPhone
    ? value.phone
    : canonicalPhone(value.phone, "LB");
  if (!unchangedPhone && !phone) throw invalid(PHONE_INPUT_MESSAGE);
  const input = allowFields(
    value.qualification,
    ["type", "level", "title", "institution"],
    "qualification",
  );
  if (!qualificationTypes.has(input.type))
    throw invalid(
      "Choose a university, technical/vocational or general Baccalaureate qualification.",
    );
  if (requiresMfa(roles) && input.type !== "university")
    throw invalid(
      "Every administrative role requires a relevant university qualification.",
    );
  const qualification = {
    type: input.type,
    title: text(input.title, "the qualification title"),
    institution: text(input.institution, "the awarding institution"),
  };
  if (input.level !== undefined) {
    qualification.level = text(input.level, "the qualification level", 80);
    if (
      input.type !== "technical_vocational" &&
      /^(BT|TS|LT)$/i.test(qualification.level)
    ) {
      throw invalid(
        "BT, TS and LT are technical qualifications, not university or general Baccalaureate levels.",
      );
    }
  } else if (
    !sameQualification(input, legacyQualification) ||
    legacyQualification.level !== undefined
  ) {
    throw invalid(
      "Enter the qualification level. Existing unrecorded levels may stay unchanged, not be invented.",
    );
  }
  return {
    firstName: text(value.firstName, "a first name", 80),
    lastName: text(value.lastName, "a last name", 80),
    fatherName: text(value.fatherName, "the father's given name", 80),
    motherName: text(value.motherName, "the mother's given name", 80),
    dateOfBirth: value.dateOfBirth,
    address: text(value.address, "an address", 400),
    phone,
    email,
    departments: [...value.departments],
    employmentStartDate: value.employmentStartDate,
    qualification,
  };
}

export function validateCreate(value, today) {
  allowFields(value, ["username", "roles", "profile"]);
  const roles = validateRoles(value.roles);
  return {
    username: normalizeUsername(value.username),
    roles,
    profile: validateManagementProfile(value.profile, roles, today),
  };
}

export function validateProfilePatch(value) {
  allowFields(value, ["expectedRevision", "profile"]);
  const profile = allowFields(
    value.profile,
    EDITABLE_PROFILE_FIELDS,
    "profile update",
  );
  if (!Object.keys(profile).length)
    throw invalid("Choose at least one profile field to update.");
  return {
    expectedRevision: expectedRevision(value.expectedRevision),
    profile,
  };
}

export function validateContact(value) {
  allowFields(value, ["expectedRevision", ...CONTACT_FIELDS]);
  const profile = {};
  for (const field of CONTACT_FIELDS)
    if (Object.hasOwn(value, field))
      profile[field] = text(
        value[field],
        `a ${field}`,
        field === "address" ? 400 : 40,
      );
  if (!Object.keys(profile).length)
    throw invalid("Choose an address or phone number to update.");
  return {
    expectedRevision: expectedRevision(value.expectedRevision),
    profile,
  };
}
