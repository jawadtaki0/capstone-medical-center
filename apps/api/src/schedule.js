const TIME_ZONE = "Asia/Beirut";

// Fictional public display data. Weekdays use Sunday = 0 through Saturday = 6.
const weeklyDoctorSessions = {
  0: [],
  1: [
    { id: "nour-monday", doctorName: "Dr. Nour Haddad", specialty: "Family Medicine", startTime: "09:00", endTime: "11:00" },
    { id: "samir-monday", doctorName: "Dr. Samir Nasser", specialty: "Internal Medicine", startTime: "13:00", endTime: "15:00" },
  ],
  2: [
    { id: "maya-tuesday", doctorName: "Dr. Maya Rahal", specialty: "Pediatrics", startTime: "10:00", endTime: "12:00" },
  ],
  3: [
    { id: "nour-wednesday", doctorName: "Dr. Nour Haddad", specialty: "Family Medicine", startTime: "09:00", endTime: "11:00" },
    { id: "hadi-wednesday", doctorName: "Dr. Hadi Salem", specialty: "ENT", startTime: "13:00", endTime: "15:00" },
  ],
  4: [
    { id: "maya-thursday", doctorName: "Dr. Maya Rahal", specialty: "Pediatrics", startTime: "10:00", endTime: "12:00" },
    { id: "samir-thursday", doctorName: "Dr. Samir Nasser", specialty: "Internal Medicine", startTime: "14:00", endTime: "16:00" },
  ],
  5: [
    { id: "hadi-friday", doctorName: "Dr. Hadi Salem", specialty: "ENT", startTime: "09:00", endTime: "11:00" },
  ],
  6: [],
};

const weeklyOtherServices = {
  0: [],
  1: [{ id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: "14:00" }],
  2: [
    { id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: "14:00" },
    { id: "audiometry", name: "Audiometry", startTime: "10:00", endTime: "13:00" },
  ],
  3: [{ id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: "14:00" }],
  4: [
    { id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: "14:00" },
    { id: "audiometry", name: "Audiometry", startTime: "10:00", endTime: "13:00" },
  ],
  5: [{ id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: "14:00" }],
  6: [{ id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: "12:00" }],
};

// One-date changes leave their regular weekly templates untouched.
const dateExceptions = {
  "2026-10-01": { doctorSessions: { "maya-thursday": { status: "cancelled" } } },
  "2026-10-02": { doctorSessions: { "hadi-friday": { startTime: "11:00", endTime: "13:00" } } },
};

export function isValidScheduleDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function getBeirutToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function getScheduleForDate(date) {
  if (!isValidScheduleDate(date)) throw new RangeError("Invalid schedule date");

  // Noon UTC determines the calendar weekday without local-midnight ambiguity.
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const overrides = dateExceptions[date]?.doctorSessions ?? {};
  const doctorSessions = weeklyDoctorSessions[weekday]
    .map((session) => ({ ...session, date, status: "active", ...overrides[session.id] }))
    .sort((first, second) => first.startTime.localeCompare(second.startTime));
  const otherServices = weeklyOtherServices[weekday]
    .map((service) => ({ ...service, date }));

  return { date, timeZone: TIME_ZONE, sampleData: true, doctorSessions, otherServices };
}
