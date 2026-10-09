import { useId, useState } from "react";
import {
  normalizedEmail,
  EMAIL_INPUT_MESSAGE,
} from "../../shared/contact-input.js";

export default function EmailInput({
  id: suppliedId,
  name = "email",
  label = "Individual email",
  defaultValue = "",
  disabled = false,
  readOnly = false,
  describedBy,
}) {
  const generated = useId(),
    id = suppliedId ?? generated;
  const [invalid, setInvalid] = useState(false);
  function validate(input) {
    const failed = !readOnly && !normalizedEmail(input.value);
    input.setCustomValidity(failed ? EMAIL_INPUT_MESSAGE : "");
    setInvalid(failed);
  }
  return (
    <div className="staff-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="email"
        defaultValue={defaultValue}
        required={!readOnly}
        readOnly={readOnly}
        disabled={disabled}
        maxLength={254}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={
          [describedBy, invalid ? `${id}-error` : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onBlur={(event) => validate(event.currentTarget)}
        onChange={(event) => validate(event.currentTarget)}
        onInvalid={(event) => validate(event.currentTarget)}
      />
      {invalid && (
        <p id={`${id}-error`} className="staff-error" role="alert">
          {EMAIL_INPUT_MESSAGE}
        </p>
      )}
    </div>
  );
}
