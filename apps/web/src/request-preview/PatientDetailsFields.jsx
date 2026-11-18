import { useId } from "react";
import { DateField, RequestPhone } from "./FormControls.jsx";

export const patientDetailsCopy = {
  en: {
    mother: "Mother’s maiden name",
    first: "First name",
    father: "Father’s name",
    last: "Last name",
    dob: "Date of birth",
    gender: "Gender",
    empty: "Choose",
    female: "Female",
    male: "Male",
  },
  ar: {
    mother: "اسم الأم قبل الزواج",
    first: "الاسم الأول",
    father: "اسم الأب",
    last: "اسم العائلة",
    dob: "تاريخ الولادة",
    gender: "الجنس",
    empty: "اختر",
    female: "أنثى",
    male: "ذكر",
  },
};

const arabicErrors = {
  firstName: "أدخل الاسم الأول (حتى ٨٠ حرفًا).",
  fatherName: "أدخل اسم الأب (حتى ٨٠ حرفًا).",
  lastName: "أدخل اسم العائلة (حتى ٨٠ حرفًا).",
  motherFirstName: "أدخل اسم الأم قبل الزواج (حتى ٨٠ حرفًا).",
  dateOfBirth: "أدخل تاريخ ولادة صحيحًا لا يقع في المستقبل.",
  gender: "اختر جنس المريض.",
  phone: "أدخل رقم هاتف صحيحًا.",
};

export default function PatientDetailsFields({
  details,
  edit,
  errors,
  language,
  phoneKey,
  showPhone = true,
  dateAllowed,
  dateError,
}) {
  const id = useId();
  const t = patientDetailsCopy[language];
  const message = (key) =>
    errors[key] && (language === "ar" ? arabicErrors[key] : errors[key]);
  return (
    <>
      <div className="request-form-grid">
        {[
          ["firstName", t.first],
          ["fatherName", t.father],
          ["lastName", t.last],
          ["motherFirstName", t.mother],
        ].map(([key, label]) => (
          <div className="request-field" key={key}>
            <label htmlFor={`${id}-${key}`}>{label}</label>
            <input
              id={`${id}-${key}`}
              value={details[key]}
              maxLength={80}
              onChange={(e) => edit(key, e.target.value)}
              aria-invalid={Boolean(message(key))}
              aria-describedby={message(key) ? `${id}-${key}-error` : undefined}
              autoComplete="off"
            />
            {message(key) && (
              <p id={`${id}-${key}-error`} className="request-error">
                {message(key)}
              </p>
            )}
          </div>
        ))}
        <DateField
          label={t.dob}
          value={details.dateOfBirth}
          onChange={(v) => edit("dateOfBirth", v)}
          dob
          language={language}
          error={dateError || message("dateOfBirth")}
          dateAllowed={dateAllowed}
        />
        <div className="request-field">
          <label htmlFor={`${id}-gender`}>{t.gender}</label>
          <select
            id={`${id}-gender`}
            value={details.gender}
            onChange={(e) => edit("gender", e.target.value)}
            aria-invalid={Boolean(message("gender"))}
            aria-describedby={
              message("gender") ? `${id}-gender-error` : undefined
            }
          >
            <option value="" disabled>
              {t.empty}
            </option>
            <option value="female">{t.female}</option>
            <option value="male">{t.male}</option>
          </select>
          {message("gender") && (
            <p className="request-error" id={`${id}-gender-error`}>
              {message("gender")}
            </p>
          )}
        </div>
      </div>
      {showPhone && (
        <RequestPhone
          key={phoneKey}
          value={details.phone}
          onChange={(v) => edit("phone", v)}
          language={language}
          error={message("phone")}
        />
      )}
    </>
  );
}
