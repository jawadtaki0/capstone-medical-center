export function knownActionCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export default function RequestActionCount({ value, label, stale = false }) {
  const count = knownActionCount(value);
  return (
    <span
      className={count > 0 ? "staff-action-count" : "staff-neutral-count"}
      aria-label={
        count === null
          ? `${label}: count unavailable`
          : `${count} ${label}${stale ? "; last known count" : ""}`
      }
      title={
        count === null
          ? "Count unavailable"
          : stale
            ? "Last known count"
            : undefined
      }
    >
      {count === null ? "—" : count}
    </span>
  );
}
