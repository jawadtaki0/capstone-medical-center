// Sole source: Jawad's confirmed English weekly schedule and clarifications.
// This baseline has no invented start date or booking capacity.
export const WEEKLY_SCHEDULE_ID = "weekly:approved-v1";
export const SEED_ID = "approved-weekly-v1";

const doctorDefinitions = [
  [
    "hasan-ezzeddine",
    "Dr. Hasan Ezzeddine",
    "Pediatrics, Neonatology, and General Health",
    "male",
  ],
  ["issam-al-tawil", "Dr. Issam Al-Tawil", "General Surgery", "male"],
  ["hasan-rahal", "Dr. Hasan Rahal", "Dentistry", "male"],
  ["hasan-abou-zaid", "Dr. Hasan Abou Zaid", "Urology", "male"],
  ["ghazi-sarghani", "Dr. Ghazi Sarghani", "ENT (Otolaryngology)", "male"],
  ["hussein-saad", "Dr. Hussein Saad", "Dentistry", "male"],
  ["mohammad-rizk", "Dr. Mohammad Rizk", "Endocrinology & Diabetes", "male"],
  ["diana-sharafeddin", "Dr. Diana Sharafeddin", "Gynecology", "female"],
  ["narjes-fadlallah", "Dr. Narjes Fadlallah", "ENT", "female"],
  ["hasan-damerji", "Dr. Hasan Damerji", "Ophthalmology & Eye Surgery", "male"],
  ["daher-roumani", "Dr. Daher Roumani", "Gastroenterology", "male"],
  ["rola-reslan", "Dr. Rola Reslan", "Dentistry", "female"],
  ["zahraa-badawi", "Dr. Zahraa Badawi", "Dermatology", "female"],
  ["soleiman-jibawi", "Dr. Soleiman Jibawi", "Gastroenterology", "male"],
  ["sawsan-el-korsifi", "Dr. Sawsan El-Korsifi", "Gynecology", "female"],
  ["ezzat-hashem", "Dr. Ezzat Hashem", "Cardiology", "male"],
];
const specialistDefinitions = [
  ["taghreed-doueibes", "Taghreed Doueibes", "Dietitian", "female"],
  ["maya-najdi", "Maya Najdi", "Therapist", "female"],
  [
    "zeinab-makahhel",
    "Zeinab Mkahhel",
    "Speech, Language, and Swallowing Therapist",
    "female",
  ],
];

function doctor(weekday, id, startTime, endTime, appointmentRequired = false) {
  return {
    id: `${weekday}:${id}`,
    doctorId: `doctor:${id}`,
    startTime,
    endTime,
    appointmentRequired,
    status: "active",
  };
}
function specialist(
  weekday,
  id,
  startTime,
  endTime,
  appointmentRequired = false,
) {
  return {
    id: `${weekday}:${id}`,
    specialistId: `specialist:${id}`,
    startTime,
    endTime,
    appointmentRequired,
    status: "active",
  };
}
function day(doctorSessions, specialistSessions = [], saturday = false) {
  return {
    closed: false,
    centerHours: { startTime: "08:00", endTime: saturday ? "13:00" : "17:00" },
    doctorSessions,
    specialistSessions,
    otherServices: [
      {
        id: "laboratory",
        name: "Laboratory",
        startTime: "08:00",
        endTime: saturday ? "13:00" : "14:30",
        status: "active",
      },
      {
        id: "audiometry",
        name: "Audiometry",
        startTime: "09:00",
        endTime: saturday ? "13:00" : "14:30",
        status: "active",
      },
    ],
  };
}

export function buildScheduleSeed(publishedAt = new Date().toISOString()) {
  const profiles = (definitions, kind) =>
    definitions.map(([id, name, specialty, gender]) => ({
      _id: `${kind}:${id}`,
      name,
      specialty,
      active: true,
      gender,
    }));
  return {
    doctors: profiles(doctorDefinitions, "doctor"),
    specialists: profiles(specialistDefinitions, "specialist"),
    weeklySchedule: {
      _id: WEEKLY_SCHEDULE_ID,
      publicationStatus: "published",
      effectiveFrom: null,
      publishedAt,
      days: {
        0: {
          closed: true,
          centerHours: null,
          doctorSessions: [],
          specialistSessions: [],
          otherServices: [],
        },
        1: day(
          [
            doctor(1, "hasan-ezzeddine", "09:00", "11:00"),
            doctor(1, "issam-al-tawil", "11:00", "12:00"),
            doctor(1, "hasan-rahal", "09:00", "17:00"),
          ],
          [specialist(1, "taghreed-doueibes", "10:30", "11:30")],
        ),
        2: day([
          doctor(2, "hasan-ezzeddine", "09:00", "11:00"),
          doctor(2, "hasan-abou-zaid", "09:00", "11:00"),
          doctor(2, "ghazi-sarghani", "12:00", "13:00"),
          doctor(2, "hasan-rahal", "09:00", "13:00"),
          doctor(2, "hussein-saad", "13:00", "17:00"),
        ]),
        3: day(
          [
            doctor(3, "hasan-ezzeddine", "09:00", "11:00"),
            doctor(3, "mohammad-rizk", "10:00", "11:00"),
            doctor(3, "diana-sharafeddin", "11:30", "12:30"),
            doctor(3, "hasan-rahal", "13:00", "17:00"),
            doctor(3, "hussein-saad", "09:00", "13:00"),
          ],
          [specialist(3, "taghreed-doueibes", "10:00", "11:00")],
        ),
        4: day(
          [
            doctor(4, "hasan-ezzeddine", "09:00", "11:00"),
            doctor(4, "narjes-fadlallah", "09:00", "10:00", true),
            doctor(4, "hasan-damerji", "10:00", "12:00"),
            doctor(4, "daher-roumani", "11:00", "12:00"),
            doctor(4, "rola-reslan", "09:00", "17:00"),
          ],
          [specialist(4, "taghreed-doueibes", "10:00", "11:00", true)],
        ),
        5: day(
          [
            doctor(5, "hasan-ezzeddine", "09:00", "11:00"),
            doctor(5, "zahraa-badawi", "09:00", "10:00"),
            doctor(5, "soleiman-jibawi", "09:30", "11:00", true),
            doctor(5, "sawsan-el-korsifi", "09:30", "11:00", true),
            doctor(5, "issam-al-tawil", "10:00", "11:00", true),
            doctor(5, "ezzat-hashem", "10:30", "11:30", true),
            doctor(5, "ghazi-sarghani", "12:00", "13:00"),
            doctor(5, "hussein-saad", "09:00", "17:00"),
          ],
          [specialist(5, "maya-najdi", "10:00", "11:00")],
        ),
        6: day(
          [
            doctor(6, "hasan-ezzeddine", "09:00", "11:00", true),
            doctor(6, "rola-reslan", "09:00", "13:00"),
          ],
          [
            specialist(6, "zeinab-makahhel", "09:30", "13:00", true),
            specialist(6, "maya-najdi", "09:30", "13:00", true),
          ],
          true,
        ),
      },
    },
  };
}
