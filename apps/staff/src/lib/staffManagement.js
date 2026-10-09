import {
  normalizedEmail,
  canonicalPhone,
  EMAIL_INPUT_MESSAGE,
  PHONE_INPUT_MESSAGE,
} from "../../shared/contact-input.js";

export const QUALIFICATION_TYPES = Object.freeze([
  { value: "university", label: "University degree" },
  {
    value: "technical_vocational",
    label: "Technical / vocational qualification",
  },
  { value: "general_baccalaureate", label: "General Lebanese Baccalaureate" },
]);
// HTML pattern uses Unicode-set (v) regex rules: a literal hyphen must be
// escaped even at the end of this character class. Server validation remains
// authoritative; this only mirrors its existing username character policy.
export const USERNAME_PATTERN = "[A-Za-z0-9._\\-]{3,40}";
const administrativeRoles = new Set([
  "Admin",
  "System Admin",
  "Clinic Admin",
  "Lab Admin",
]);
const protectedRoles = new Set(["Admin", "System Admin"]);
const statuses = {
  active: "Active",
  setup_pending: "Password setup pending",
  mfa_pending: "MFA enrollment pending",
  disabled: "Disabled",
};
const activationLabels = {
  awaiting_password: "Password setup pending",
  mfa_enrollment: "MFA enrollment pending",
  backup_acknowledgement: "Backup acknowledgement pending",
  activated: "Active",
  disabled: "Disabled",
};
const legacyActivationStates = {
  setup_pending: "awaiting_password",
  mfa_pending: "mfa_enrollment",
  active: "activated",
  disabled: "disabled",
};
export const STAFF_STATUS_OPTIONS = Object.freeze(
  Object.entries(activationLabels).map(([value, label]) =>
    Object.freeze({ value, label }),
  ),
);
const normalize = (value) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export function statusLabel(status) {
  return statuses[status] ?? "Unknown status";
}
// The server derives activation without exposing any MFA secret. An account can
// have stored active status while its once-only backup acknowledgement is gated.
export function staffStatusKey(account) {
  return Object.hasOwn(activationLabels, account?.activationState)
    ? account.activationState
    : (legacyActivationStates[account?.status] ?? "unknown");
}
export function accountStatusLabel(account) {
  return activationLabels[staffStatusKey(account)] ?? "Unknown status";
}
export function assertManagementActionLive(alive) {
  if (!alive)
    throw Object.assign(
      new Error(
        "This management screen is no longer open. No further action was started.",
      ),
      { code: "action_cancelled" },
    );
}
export function canViewStaffDirectory(user) {
  return user?.roles?.some((role) => protectedRoles.has(role)) === true;
}
export function canManageProfile(user, target) {
  return (
    canViewStaffDirectory(user) && Boolean(target?.id) && user.id !== target.id
  );
}
export function canManageIdentity(user, target) {
  return canManageProfile(user, target) && user.roles.includes("Admin");
}

// Email refresh must never silently discard a dirty address or overwrite a
// concurrently changed saved address. Keep the draft and require review.
export function refreshedAddress(previous, next, draft) {
  const dirty = draft !== previous.address;
  return {
    draft: dirty ? draft : next.address,
    conflict: dirty && next.address !== previous.address,
  };
}
export function canManageWorkDetails(user, target) {
  return (
    canManageProfile(user, target) &&
    (user.roles.includes("Admin") ||
      !target.roles.some((role) => protectedRoles.has(role)))
  );
}
export function canControlAccount(user, target) {
  return (
    canManageProfile(user, target) &&
    (user.roles.includes("Admin") ||
      !target.roles.some((role) => protectedRoles.has(role)))
  );
}
export function canReleaseEmail(user, record) {
  return (
    canManageProfile(user, record?.account) &&
    user.roles.includes("Admin") &&
    record.account.status === "disabled" &&
    ["verified", "test_only"].includes(record.profile?.contactStatus?.email)
  );
}
export function assignableRoles(user, roles) {
  if (!canViewStaffDirectory(user)) return [];
  return roles.filter(
    (role) => user.roles.includes("Admin") || !protectedRoles.has(role),
  );
}

export function filterStaff(
  staff,
  { query = "", role = "", department = "", status = "" } = {},
) {
  const needle = normalize(query);
  return staff.filter(
    (person) =>
      (!role || person.roles.includes(role)) &&
      (!department || person.departments.includes(department)) &&
      (!status ||
        staffStatusKey(person) ===
          (legacyActivationStates[status] ?? status)) &&
      (!needle ||
        [
          person.name,
          person.username,
          ...person.roles,
          ...person.departments,
          accountStatusLabel(person),
        ].some((value) => normalize(value).includes(needle))),
  );
}

export function managementProfile(formData, { includeEmail = true } = {}) {
  const text = (key) => String(formData.get(key) ?? "").trim();
  const level = text("qualificationLevel");
  return {
    firstName: text("firstName"),
    lastName: text("lastName"),
    fatherName: text("fatherName"),
    motherName: text("motherName"),
    dateOfBirth: text("dateOfBirth"),
    address: text("address"),
    phone: text("phone"),
    ...(includeEmail ? { email: text("email") } : {}),
    departments: formData.getAll("departments"),
    employmentStartDate: text("employmentStartDate"),
    qualification: {
      type: text("qualificationType"),
      ...(level ? { level } : {}),
      title: text("qualificationTitle"),
      institution: text("qualificationInstitution"),
    },
  };
}

export function preservesLegacyQualification(qualification, existing) {
  return Boolean(
    existing &&
    !existing.level &&
    !qualification.level &&
    qualification.type === existing.type &&
    qualification.title === existing.title &&
    qualification.institution === existing.institution,
  );
}

export function changedProfileFields(profile, existing) {
  const fields = [
    "firstName",
    "lastName",
    "fatherName",
    "motherName",
    "dateOfBirth",
    "address",
    "phone",
    "departments",
    "employmentStartDate",
    "qualification",
  ];
  const comparable = (key, value) =>
    key === "departments"
      ? [...(value ?? [])].sort()
      : key === "qualification"
        ? [
            value?.type ?? "",
            value?.level ?? "",
            value?.title ?? "",
            value?.institution ?? "",
          ]
        : value;
  return Object.fromEntries(
    fields
      .filter(
        (key) =>
          JSON.stringify(comparable(key, profile[key])) !==
          JSON.stringify(comparable(key, existing[key])),
      )
      .map((key) => [key, profile[key]]),
  );
}

export function validateManagementProfile(
  profile,
  roles,
  existingQualification,
  existingContacts,
) {
  if (!Array.isArray(roles) || !roles.length)
    return "Choose at least one role.";
  if (!profile.departments.length) return "Choose at least one department.";
  if (
    !QUALIFICATION_TYPES.some(
      ({ value }) => value === profile.qualification.type,
    )
  )
    return "Choose a qualification type.";
  if (
    !profile.qualification.level &&
    !preservesLegacyQualification(profile.qualification, existingQualification)
  ) {
    return "Enter the qualification level. Existing missing information is not filled in automatically.";
  }
  if (
    roles.some((role) => administrativeRoles.has(role)) &&
    profile.qualification.type !== "university"
  ) {
    return "Every administrative role requires a relevant university degree. Review all selected roles and the actual qualification.";
  }
  if (
    profile.qualification.type !== "technical_vocational" &&
    /^(bt|ts|lt)$/i.test(profile.qualification.level?.trim() ?? "")
  ) {
    return "BT, TS and LT belong to technical/vocational qualifications, not university degrees or general Baccalaureate.";
  }
  if (
    Object.hasOwn(profile, "email") &&
    profile.email !== existingContacts?.email &&
    !normalizedEmail(profile.email)
  )
    return EMAIL_INPUT_MESSAGE;
  if (
    profile.phone !== existingContacts?.phone &&
    !canonicalPhone(profile.phone, "LB")
  )
    return PHONE_INPUT_MESSAGE;
  return "";
}

export function managementErrorMessage(error) {
  return typeof error?.message === "string"
    ? error.message
    : "This action could not be completed. Please try again.";
}
export function isAccessError(error) {
  const code = String(error?.code ?? "").toLowerCase();
  if (code.startsWith("contact_")) return false;
  if (code.startsWith("verification_") || code === "challenge_expired")
    return false;
  return (
    code.includes("unavailable") ||
    code.includes("expired") ||
    code.includes("revoked") ||
    code.includes("auth_required") ||
    code === "authentication_failed"
  );
}
export function contactLabel(value) {
  return value === "verified"
    ? "verified"
    : value === "released"
      ? "released — not currently verified"
      : value === "test_only"
        ? "automated test only — not real verification"
        : "unverified";
}
export function handoffExpiry(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Beirut",
      }).format(date)
    : "Not provided by the server";
}
