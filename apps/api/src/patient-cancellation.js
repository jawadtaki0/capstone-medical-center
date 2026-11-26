import {
  beirutEnd,
  requestFail,
} from "../../../shared/website-request-contract.mjs";

export function cancellationEligibility(row, now, cutoffMinutes) {
  if (!["awaiting", "confirmed"].includes(row.status))
    return { eligible: false, reason: "status" };
  const { date, startTime } = row.selection ?? {};
  const start = date && startTime ? beirutEnd(date, startTime) : NaN;
  if (!Number.isFinite(Number(start)) || start <= now)
    return { eligible: false, reason: "past" };
  if (+start - +now < cutoffMinutes * 60_000)
    return { eligible: false, reason: "cutoff" };
  return { eligible: true };
}

const codes = new Set([
  "feeling_better",
  "schedule_conflict",
  "booked_elsewhere",
  "going_elsewhere",
  "cost",
  "transport",
  "other",
]);

export function cancellationReasons(selected = [], note = "") {
  if (
    !Array.isArray(selected) ||
    selected.length > codes.size ||
    new Set(selected).size !== selected.length ||
    !selected.every((code) => codes.has(code)) ||
    typeof note !== "string" ||
    note.length > 200 ||
    /[\p{Cc}]/u.test(note) ||
    (note.trim() && !selected.includes("other"))
  )
    throw requestFail(
      "invalid_cancellation_reason",
      "Check the cancellation reasons.",
      400,
    );
  return selected.map((code) =>
    code === "other" && note.trim() ? { code, note: note.trim() } : { code },
  );
}
