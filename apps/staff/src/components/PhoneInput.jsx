import { useId, useState } from "react";
import {
  PHONE_COUNTRIES,
  PHONE_INPUT_MESSAGE,
  callingCode,
  countryFlag,
  phoneExample,
  phoneNumber,
  canonicalPhone,
  formattedPhoneInput,
} from "../../shared/contact-input.js";

const names = new Intl.DisplayNames(["en"], { type: "region" });
const countries = [...PHONE_COUNTRIES].sort((a, b) =>
  names.of(a).localeCompare(names.of(b)),
);
export default function PhoneInput({
  disabled = false,
  label = "Phone",
  defaultValue = "",
  onValueChange,
  error = "",
  className = "",
  validateOnBlur = true,
}) {
  const id = useId();
  const [initial] = useState(() => phoneNumber(defaultValue, "LB"));
  const [country, setCountry] = useState(initial?.country ?? "LB"),
    [value, setValue] = useState(initial?.formatNational() ?? defaultValue),
    [touched, setTouched] = useState(false);
  const canonical = canonicalPhone(value, country),
    invalid = Boolean(error) || (touched && !canonical);
  function changed(input) {
    const raw = input.value;
    const parsed = phoneNumber(raw, country);
    // International paste selects the country from library metadata, not a
    // handwritten prefix table; the visible input remains a national number.
    const international =
      raw.trim().startsWith("+") || raw.trim().startsWith("00");
    const nextCountry = international && parsed ? parsed.country : country;
    setCountry(nextCountry);
    setValue(
      international && parsed
        ? parsed.formatNational()
        : formattedPhoneInput(raw, nextCountry),
    );
    input.setCustomValidity(parsed ? "" : PHONE_INPUT_MESSAGE);
    setTouched(true);
    onValueChange?.(canonicalPhone(raw, nextCountry) ?? "");
  }
  return (
    <div className={`staff-field staff-phone-field ${className}`}>
      <div className="staff-field staff-phone-country">
        <label htmlFor={`${id}-country`}>Phone country</label>
        <select
          id={`${id}-country`}
          value={country}
          disabled={disabled}
          onChange={(event) => {
            setCountry(event.target.value);
            setValue("");
            setTouched(false);
            onValueChange?.("");
            event.currentTarget.form?.elements
              .namedItem("phoneNational")
              ?.setCustomValidity("");
          }}
        >
          {countries.map((code) => (
            <option key={code} value={code}>
              {countryFlag(code)} {names.of(code)} +{callingCode(code)}
            </option>
          ))}
        </select>
      </div>
      <div className="staff-field staff-phone-entry">
        <label htmlFor={`${id}-number`}>{label}</label>
        <div className="staff-phone-number">
          <span aria-hidden="true">+{callingCode(country)}</span>
          <input
            id={`${id}-number`}
            name="phoneNational"
            type="tel"
            inputMode="tel"
            value={value}
            onChange={(event) => changed(event.currentTarget)}
            onBlur={() => {
              if (validateOnBlur) setTouched(true);
            }}
            onInvalid={(event) => {
              event.currentTarget.setCustomValidity(PHONE_INPUT_MESSAGE);
              setTouched(true);
            }}
            required
            disabled={disabled}
            autoComplete="off"
            maxLength={80}
            placeholder={phoneExample(country)}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-help ${invalid ? `${id}-error` : ""}`}
          />
        </div>
        <input name="phone" type="hidden" value={canonical ?? value} />
        <p id={`${id}-help`} className="staff-help">
          For example, {phoneExample(country)}. Spaces, hyphens and
          international paste are supported. Structure is not ownership
          verification.
        </p>
        {invalid && (
          <p id={`${id}-error`} className="staff-error" role="alert">
            {error || PHONE_INPUT_MESSAGE}
          </p>
        )}
      </div>
    </div>
  );
}
