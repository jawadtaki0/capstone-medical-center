import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberWithError,
} from "libphonenumber-js/max";
import examples from "libphonenumber-js/examples.mobile.json";

export const EMAIL_INPUT_MESSAGE =
  "Enter a valid email address, such as name@example.com.";
export function normalizedEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length > 254 || /\s/.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  )
    return null;
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    )
  )
    return null;
  if (!/^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{2,59})$/i.test(labels.at(-1)))
    return null;
  return email.toLowerCase();
}

export const PHONE_INPUT_MESSAGE =
  "Enter a valid phone number for the selected country.";
export const PHONE_COUNTRIES = Object.freeze(getCountries());
export const callingCode = (country) => getCountryCallingCode(country);
export function phoneNumber(value, country = "LB") {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^[+\d\s().-]+$/.test(value.trim()) ||
    !PHONE_COUNTRIES.includes(country)
  )
    return null;
  try {
    const number = parsePhoneNumberWithError(value.trim(), {
      defaultCountry: country,
      extract: false,
    });
    return !number.ext && number.country && number.isValid() ? number : null;
  } catch {
    return null;
  }
}
export const canonicalPhone = (value, country = "LB") =>
  phoneNumber(value, country)?.number ?? null;
export function formattedPhoneInput(value, country = "LB") {
  if (typeof value !== "string" || !/^[+\d\s().-]*$/.test(value)) return value;
  return new AsYouType(country).input(value);
}
export function phoneExample(country) {
  return (
    getExampleNumber(country, examples)?.formatNational() ??
    "National phone number"
  );
}
export function countryFlag(country) {
  return String.fromCodePoint(
    ...[...country].map((letter) => 127397 + letter.charCodeAt(0)),
  );
}
export function savedLebanesePhone(value) {
  const number = phoneNumber(value, "LB");
  // Existing values are explicitly Lebanese. Never infer another legacy country
  // or rewrite stored digits; formatting is presentation, not possession proof.
  return number?.country === "LB"
    ? { display: number.formatInternational(), legacyInvalid: false }
    : { display: String(value ?? ""), legacyInvalid: true };
}

export function savedPhone(profile) {
  // New accepted entries carry server-derived country metadata. Older records
  // have no backfill: their user-confirmed interpretation remains Lebanon.
  const country = PHONE_COUNTRIES.includes(profile?.phoneCountry)
    ? profile.phoneCountry
    : "LB";
  const number = phoneNumber(profile?.phone, country);
  return {
    display:
      number?.country === country
        ? number.formatInternational()
        : String(profile?.phone ?? ""),
    legacyInvalid: number?.country !== country,
    countryName: new Intl.DisplayNames(["en"], { type: "region" }).of(country),
  };
}
