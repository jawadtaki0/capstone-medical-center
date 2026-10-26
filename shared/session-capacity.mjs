export const PATIENT_LIMIT_RULE = "manual-nullable-v1";

export function validPatientLimit(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

// Used only at the form boundary. Stored/API values are numbers or explicit null.
export function parsePatientLimit(value) {
  if (value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !validPatientLimit(Number(value))
  )
    throw new Error("Enter a positive whole patient limit, or leave it blank.");
  return Number(value);
}
