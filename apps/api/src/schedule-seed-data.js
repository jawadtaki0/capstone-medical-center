// Sole source: Jawad's confirmed English weekly schedule and clarifications.
// This baseline has no invented start date or booking capacity.
import { CENTER_ID } from "./schedule-model.js";
export const WEEKLY_SCHEDULE_ID = "cedar:weekly:approved-v1";
export const SEED_ID = "cedar:approved-weekly-v1";

const doctorDefinitions = [
  ["hasan-ezzeddine", "Dr. Hasan Ezzeddine", "Pediatrics, Neonatology, and General Health"],
  ["issam-al-tawil", "Dr. Issam Al-Tawil", "General Surgery"],
  ["hasan-rahal", "Dr. Hasan Rahal", "Dentistry"],
  ["hasan-abou-zaid", "Dr. Hasan Abou Zaid", "Urology"],
  ["ghazi-sarghani", "Dr. Ghazi Sarghani", "ENT (Otolaryngology)"],
  ["hussein-saad", "Dr. Hussein Saad", "Dentistry"],
  ["mohammad-rizk", "Dr. Mohammad Rizk", "Endocrinology & Diabetes"],
  ["diana-sharafeddin", "Dr. Diana Sharafeddin", "Gynecology"],
  ["narjes-fadlallah", "Dr. Narjes Fadlallah", "ENT"],
  ["hasan-damerji", "Dr. Hasan Damerji", "Ophthalmology & Eye Surgery"],
  ["daher-roumani", "Dr. Daher Roumani", "Gastroenterology"],
  ["rola-reslan", "Dr. Rola Reslan", "Dentistry"],
  ["zahraa-badawi", "Dr. Zahraa Badawi", "Dermatology"],
  ["soleiman-jibawi", "Dr. Soleiman Jibawi", "Gastroenterology"],
  ["sawsan-el-korsifi", "Dr. Sawsan El-Korsifi", "Gynecology"],
  ["ezzat-hashem", "Dr. Ezzat Hashem", "Cardiology"],
];
const specialistDefinitions = [
  ["taghreed-doueibes", "Taghreed Doueibes", "Dietitian"],
  ["maya-najdi", "Maya Najdi", "Psychological & Behavioral Specialist (Therapist)"],
  ["zeinab-makahhel", "Zeinab Makahhel", "Speech, Language, and Swallowing Therapist"],
];

function doctor(weekday, id, startTime, endTime, appointmentRequired = false) {
  return { id: `${weekday}:${id}`, doctorId: `cedar:doctor:${id}`, startTime, endTime, appointmentRequired, status: "active" };
}
function specialist(weekday, id, startTime, endTime, appointmentRequired = false) {
  return { id: `${weekday}:${id}`, specialistId: `cedar:specialist:${id}`, startTime, endTime, appointmentRequired, status: "active" };
}
function day(doctorSessions, specialistSessions = [], saturday = false) {
  return {
    closed: false,
    centerHours: { startTime: "08:00", endTime: saturday ? "13:00" : "17:00" },
    doctorSessions,
    specialistSessions,
    otherServices: [
      { id: "laboratory", name: "Laboratory", startTime: "08:00", endTime: saturday ? "13:00" : "14:30", status: "active" },
      { id: "audiometry", name: "Audiometry", startTime: "09:00", endTime: saturday ? "13:00" : "14:30", status: "active" },
    ],
  };
}

export function buildScheduleSeed(publishedAt = new Date().toISOString()) {
  const profiles = (definitions, kind) => definitions.map(([id, name, specialty]) => ({
    _id: `cedar:${kind}:${id}`, centerId: CENTER_ID, name, specialty,
    publicationStatus: "published", active: true,
  }));
  return {
    doctors: profiles(doctorDefinitions, "doctor"),
    specialists: profiles(specialistDefinitions, "specialist"),
    weeklySchedule: {
      _id: WEEKLY_SCHEDULE_ID,
      centerId: CENTER_ID,
      publicationStatus: "published",
      // null is the owner-confirmed baseline; later revisions use YYYY-MM-DD.
      effectiveFrom: null,
      publishedAt,
      source: "owner_confirmed_weekly_schedule",
      days: {
        0: { closed: true, centerHours: null, doctorSessions: [], specialistSessions: [], otherServices: [] },
        1: day([
          doctor(1, "hasan-ezzeddine", "09:00", "11:00"),
          doctor(1, "issam-al-tawil", "11:00", "12:00"),
          doctor(1, "hasan-rahal", "09:00", "17:00"),
        ], [specialist(1, "taghreed-doueibes", "10:30", "11:30")]),
        2: day([
          doctor(2, "hasan-ezzeddine", "09:00", "11:00"),
          doctor(2, "hasan-abou-zaid", "09:00", "11:00"),
          doctor(2, "ghazi-sarghani", "12:00", "13:00"),
          doctor(2, "hasan-rahal", "09:00", "13:00"),
          doctor(2, "hussein-saad", "13:00", "17:00"),
        ]),
        3: day([
          doctor(3, "hasan-ezzeddine", "09:00", "11:00"),
          doctor(3, "mohammad-rizk", "10:00", "11:00"),
          doctor(3, "diana-sharafeddin", "11:30", "12:30"),
          doctor(3, "hasan-rahal", "13:00", "17:00"),
          doctor(3, "hussein-saad", "09:00", "13:00"),
        ], [specialist(3, "taghreed-doueibes", "10:00", "11:00")]),
        4: day([
          doctor(4, "hasan-ezzeddine", "09:00", "11:00"),
          doctor(4, "narjes-fadlallah", "09:00", "10:00", true),
          doctor(4, "hasan-damerji", "10:00", "12:00"),
          doctor(4, "daher-roumani", "11:00", "12:00"),
          doctor(4, "rola-reslan", "09:00", "17:00"),
        ], [specialist(4, "taghreed-doueibes", "10:00", "11:00", true)]),
        5: day([
          doctor(5, "hasan-ezzeddine", "09:00", "11:00"),
          doctor(5, "zahraa-badawi", "09:00", "10:00"),
          doctor(5, "soleiman-jibawi", "09:30", "11:00", true),
          doctor(5, "sawsan-el-korsifi", "09:30", "11:00", true),
          doctor(5, "issam-al-tawil", "10:00", "11:00", true),
          doctor(5, "ezzat-hashem", "10:30", "11:30", true),
          doctor(5, "ghazi-sarghani", "12:00", "13:00"),
          doctor(5, "hussein-saad", "09:00", "17:00"),
        ], [specialist(5, "maya-najdi", "10:00", "11:00")]),
        6: day([
          doctor(6, "hasan-ezzeddine", "09:00", "11:00", true),
          doctor(6, "rola-reslan", "09:00", "13:00"),
        ], [
          specialist(6, "zeinab-makahhel", "09:30", "13:00", true),
          specialist(6, "maya-najdi", "09:30", "13:00", true),
        ], true),
      },
    },
  };
}
