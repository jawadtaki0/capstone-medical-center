export function beirutToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function dateObject(date) {
  return new Date(`${date}T12:00:00Z`);
}

export function addDays(date, count) {
  const result = dateObject(date);
  result.setUTCDate(result.getUTCDate() + count);
  return result.toISOString().slice(0, 10);
}

export function mondayOf(date) {
  const weekday = dateObject(date).getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

export function formatDate(date, options) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    ...options,
  }).format(dateObject(date));
}

export function longDate(date) {
  return formatDate(date, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function timeRange(startTime, endTime) {
  function time(value) {
    const [hour, minute] = value.split(":").map(Number);
    return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  }
  return `${time(startTime)}–${time(endTime)}`;
}
