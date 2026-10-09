import { useId, useState } from "react";
import EmailInput from "./EmailInput.jsx";
import PhoneInput from "./PhoneInput.jsx";
import { savedPhone } from "../../shared/contact-input.js";
import { STAFF_DEPARTMENTS } from "../lib/profile.js";
import {
  preservesLegacyQualification,
  QUALIFICATION_TYPES,
} from "../lib/staffManagement.js";

export default function StaffProfileFields({
  profile = {},
  departments = STAFF_DEPARTMENTS,
  disabled = false,
  emailLocked = false,
  phoneLocked = false,
  identityLocked = false,
  workDetailsLocked = false,
  onNameChange,
}) {
  const id = useId();
  const [qualification, setQualification] = useState(() => ({
    type: profile.qualification?.type ?? "university",
    level: profile.qualification?.level ?? "",
    title: profile.qualification?.title ?? "",
    institution: profile.qualification?.institution ?? "",
  }));
  const legacyUnchanged = preservesLegacyQualification(
    qualification,
    profile.qualification,
  );
  function updateQualification(key, value) {
    setQualification((current) => ({ ...current, [key]: value }));
  }
  const field = (key, label, type = "text") => (
    <div className="staff-field" key={key}>
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        name={key}
        type={type}
        defaultValue={profile[key] ?? ""}
        required
        disabled={disabled}
        readOnly={
          (identityLocked &&
            [
              "firstName",
              "lastName",
              "fatherName",
              "motherName",
              "dateOfBirth",
            ].includes(key)) ||
          (workDetailsLocked && key === "employmentStartDate") ||
          (phoneLocked && key === "phone")
        }
        aria-describedby={
          identityLocked &&
          [
            "firstName",
            "lastName",
            "fatherName",
            "motherName",
            "dateOfBirth",
          ].includes(key)
            ? `${id}-identity-help`
            : key === "phone" && phoneLocked
              ? `${id}-phone-help`
              : key === "employmentStartDate" && workDetailsLocked
                ? `${id}-work-help`
                : undefined
        }
        autoComplete="off"
        onChange={
          key === "firstName" || key === "lastName"
            ? (event) => onNameChange?.(key, event.target.value)
            : undefined
        }
      />
    </div>
  );
  return (
    <>
      <fieldset disabled={disabled} className="staff-fieldset">
        <legend>Individual staff profile</legend>
        <div className="staff-form-grid">
          {field("firstName", "First name")}
          {field("lastName", "Last name")}
          {field("fatherName", "Father’s given name")}
          {field("motherName", "Mother’s name (given name only)")}
          {field("dateOfBirth", "Date of birth", "date")}
          {field("employmentStartDate", "Employment start date", "date")}
        </div>
        <div className="staff-form-grid staff-contact-grid">
          <div className="staff-contact-stack">
            {field("address", "Address")}
            <div className="staff-field">
              <EmailInput
                id={`${id}-email`}
                defaultValue={profile.email ?? ""}
                readOnly={emailLocked}
                disabled={disabled}
                describedBy={`${id}-email-help`}
              />
              <p id={`${id}-email-help`} className="staff-help">
                {emailLocked
                  ? "Saved email is read-only here. Only the employee may replace it through My Profile and possession verification; recovery remains unavailable."
                  : "Initial contact information is unverified; recovery is not enabled."}
              </p>
            </div>
          </div>
          <div className="staff-contact-stack">
            {phoneLocked ? (
              field("phone", "Phone", "tel")
            ) : (
              <PhoneInput disabled={disabled} />
            )}
            {phoneLocked && (
              <p id={`${id}-phone-help`} className="staff-help">
                Saved phone — unverified
                {savedPhone(profile).legacyInvalid
                  ? " / legacy invalid number"
                  : ` (${savedPhone(profile).countryName})`}
                . Phone changes are unavailable until real WhatsApp verification
                is configured and tested.
              </p>
            )}
          </div>
        </div>
        <p className="staff-help">
          These are private personnel fields. Parents’ names and date of birth
          are never authentication or recovery evidence.
        </p>
      </fieldset>
      {identityLocked && (
        <p id={`${id}-identity-help`} className="staff-help">
          Identity and qualifications are read-only. Only another Admin may
          change these fields on any staff profile.
        </p>
      )}
      <fieldset
        disabled={disabled || workDetailsLocked}
        className="staff-fieldset"
      >
        <legend>
          {workDetailsLocked
            ? "Departments — read-only"
            : "Departments — choose at least one"}
        </legend>
        <div className="staff-checkboxes">
          {departments.map((department) => (
            <label key={department}>
              <input
                type="checkbox"
                name="departments"
                value={department}
                defaultChecked={
                  profile.departments?.includes(department) ?? false
                }
              />
              {department}
            </label>
          ))}
        </div>
        <p className="staff-help">
          Department assignments describe work; they do not grant permissions.
        </p>
      </fieldset>
      {workDetailsLocked && (
        <p id={`${id}-work-help`} className="staff-help">
          Only another Admin may change this account’s departments or employment
          start date. Other permitted personal fields remain editable.
        </p>
      )}
      <fieldset
        disabled={disabled || identityLocked}
        className="staff-fieldset"
        aria-describedby={identityLocked ? `${id}-identity-help` : undefined}
      >
        <legend>
          {identityLocked
            ? "One actual qualification — read-only"
            : "One actual qualification"}
        </legend>
        <div className="staff-form-grid">
          <div className="staff-field">
            <label htmlFor={`${id}-qualification-type`}>
              Qualification type
            </label>
            <select
              id={`${id}-qualification-type`}
              name="qualificationType"
              value={qualification.type}
              required
              onChange={(event) =>
                updateQualification("type", event.target.value)
              }
            >
              {QUALIFICATION_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="staff-field">
            <label htmlFor={`${id}-qualification-level`}>
              Qualification level
            </label>
            <input
              id={`${id}-qualification-level`}
              name="qualificationLevel"
              value={qualification.level}
              required={!legacyUnchanged}
              onChange={(event) =>
                updateQualification("level", event.target.value)
              }
              autoComplete="off"
              aria-describedby={`${id}-qualification-help`}
            />
          </div>
          <div className="staff-field">
            <label htmlFor={`${id}-qualification-title`}>
              Title / subject / branch
            </label>
            <input
              id={`${id}-qualification-title`}
              name="qualificationTitle"
              value={qualification.title}
              required
              onChange={(event) =>
                updateQualification("title", event.target.value)
              }
              autoComplete="off"
            />
          </div>
          <div className="staff-field">
            <label htmlFor={`${id}-qualification-institution`}>
              Awarding school / university / institution
            </label>
            <input
              id={`${id}-qualification-institution`}
              name="qualificationInstitution"
              value={qualification.institution}
              required
              onChange={(event) =>
                updateQualification("institution", event.target.value)
              }
              autoComplete="off"
            />
          </div>
        </div>
        <p id={`${id}-qualification-help`} className="staff-help">
          {legacyUnchanged
            ? "This existing qualification has no recorded level. It may remain unset only while the qualification is unchanged; enter it only if confirmed. "
            : "Record the actual applicable level, such as Bachelor’s or a technical BT, TS or LT. "}
          General Baccalaureate is distinct from technical BT. TS/LT do not
          automatically count as university degrees. Managers assess relevance;
          qualifications do not grant roles.
        </p>
      </fieldset>
    </>
  );
}
