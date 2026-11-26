import { rulesCopy } from "./public-assistant-gate.js";
import { requestSelectionUrl } from "../src/request-selection.js";

export const copy = {
  en: {
    unrelated:
      "I can help with Cedar’s clinics, lab tests, and appointment requests. What would you like to know?",
    reception:
      "Please contact Reception for that information. I can help with Cedar’s public services, published sessions, and lab education.",
    unavailable:
      "I couldn’t load the published schedule. Try again or contact Reception.",
    empty:
      "No published sessions match those filters. Try another date, professional, or time.",
    emptyCardiologyTomorrow:
      "I couldn’t find any published cardiology sessions for tomorrow",
    chooseSession:
      "Which session do you mean? Tell me its time or select Open request form on its card. Reception confirms requests.",
    sessions:
      "These are published attendance windows. The request form checks the current schedule, and Reception confirms requests.",
    clinic:
      "Cedar publishes Clinic attendance windows for doctors and specialists. You can request a session for Reception to review.",
    laboratory:
      "Cedar publishes Laboratory hours and general test information. Contact Reception for availability, pricing, or instructions for your own order.",
    labs: "Compare what the published entries describe. Contact Reception to confirm test availability or instructions for an order.",
  },
  ar: {
    unrelated:
      "يمكنني مساعدتك في عيادات سيدر وفحوصات المختبر وطلبات المواعيد. ماذا تود أن تعرف؟",
    reception:
      "يرجى التواصل مع الاستقبال لهذه المعلومات. يمكنني مساعدتك في خدمات سيدر العامة والجلسات المنشورة والمعلومات المخبرية العامة.",
    unavailable:
      "تعذّر تحميل الجدول المنشور. حاول مجددًا أو تواصل مع الاستقبال.",
    empty:
      "لا توجد جلسات منشورة تطابق البحث. جرّب تاريخًا أو اختصاصيًا أو وقتًا آخر.",
    emptyCardiologyTomorrow: "لم أجد أي جلسات منشورة لأمراض القلب غدًا",
    chooseSession:
      "أي جلسة تقصد؟ اذكر وقتها أو افتح نموذج الطلب من بطاقتها. يؤكد الاستقبال الطلبات.",
    sessions:
      "هذه مواعيد الحضور المنشورة. يتحقق نموذج الطلب من الجدول الحالي، ويؤكد الاستقبال الطلبات.",
    clinic:
      "ينشر سيدر مواعيد حضور الأطباء والاختصاصيين. يمكنك طلب جلسة ليراجعها الاستقبال.",
    laboratory:
      "ينشر سيدر ساعات المختبر ومعلومات عامة عن الفحوصات. تواصل مع الاستقبال لمعرفة التوفّر والأسعار وتعليمات طلبك.",
    labs: "يمكنك مقارنة المعلومات العامة المنشورة. تواصل مع الاستقبال للتأكد من توفّر الفحص أو تعليمات طلبك.",
  },
};

export const sessionCard = (row) => ({
  professional: row.professionalName,
  specialty: row.specialty,
  date: row.date,
  start: row.startTime,
  end: row.endTime,
  href: requestSelectionUrl(row),
});
export function renderReply(kind, language, fields = {}, prefix = "") {
  return {
    kind,
    text: prefix + (copy[language][kind] ?? rulesCopy[language][kind]),
    ...fields,
  };
}

const arabicSample = {
  blood: "دم",
  urine: "بول",
  stool: "براز",
  "stool collected with the supplied FIT kit":
    "براز يُجمع باستخدام عُدّة FIT المرفقة",
};

export function labCards(tests, lang) {
  return tests.map(({ id, name, sample, description, sources }) => ({
    id,
    name,
    sample: lang === "ar" ? arabicSample[sample] : sample,
    description,
    source: sources[0]?.url,
  }));
}

export function renderHours(facts, language) {
  const names =
    language === "ar"
      ? { center: "المركز", laboratory: "المختبر", audiometry: "فحوصات السمع" }
      : {
          center: "Center",
          laboratory: "Laboratory",
          audiometry: "Audiometry",
        };

  const { days, closingOnly } = facts;
  const ar = language === "ar";
  const rendered = days.map(({ day, state, services }) => {
    if (state === "unavailable")
      return {
        text: ar
          ? `الساعات المنشورة غير متاحة ليوم ${day}.`
          : `Published hours could not be checked for ${day}.`,
        complete: false,
      };
    if (state === "closed")
      return {
        text: ar ? `المركز مغلق في ${day}.` : `The center is closed on ${day}.`,
        complete: true,
      };
    return {
      complete: services.every(({ hours }) => hours),
      text: services
        .map(({ label, hours }) => {
          if (!hours)
            return ar
              ? `ساعات ${names[label]} غير منشورة في ${day}.`
              : `${names[label]} hours are not published for ${day}.`;
          const { startTime, endTime } = hours;
          if (!closingOnly)
            return `${names[label]} ${day}: ${startTime}–${endTime}`;
          return ar
            ? `يغلق ${names[label]} في ${day} عند ${endTime} بتوقيت بيروت`
            : `The ${names[label]} closes at ${endTime} Beirut time on ${day}`;
        })
        .join(". "),
    };
  });
  const complete = rendered.every((entry) => entry.complete);
  const note =
    language === "ar"
      ? (closingOnly ? "" : "الأوقات بتوقيت بيروت. ") +
        "تواصل مع الاستقبال لتأكيد توفر الخدمة وتعليمات الزيارة."
      : (closingOnly ? "" : "Times are in Beirut. ") +
        "Published hours are not an appointment or a guarantee of individual availability. Contact Reception to confirm visit requirements.";
  return {
    text:
      rendered
        .map(({ text }) => text)
        .join(". ")
        .replace(/\.$/, "") +
      ". " +
      note,
    complete,
    day: days.length === 1 ? days[0].day : null,
  };
}

const arabicSpecialties = {
  "Pediatrics, Neonatology, and General Health":
    "طب الأطفال وحديثي الولادة والصحة العامة",
  Dentistry: "طب الأسنان",
  Cardiology: "أمراض القلب",
  Urology: "المسالك البولية",
  ENT: "الأنف والأذن والحنجرة",
  "Ophthalmology & Eye Surgery": "طب وجراحة العيون",
  Gynecology: "طب النساء",
  Gastroenterology: "أمراض الجهاز الهضمي",
  "Endocrinology & Diabetes": "الغدد الصماء والسكري",
  Dietitian: "التغذية",
  Therapist: "العلاج",
  "Speech, Language, and Swallowing Therapist": "علاج النطق واللغة والبلع",
  Dermatology: "الأمراض الجلدية",
  "General Surgery": "الجراحة العامة",
};

export const arabicSpecialty = (label) => arabicSpecialties[label] ?? label;

export function renderClinicSummary(cards, language) {
  const ar = language === "ar";
  const windows = cards.map(({ professional, specialty, date, start, end }) =>
    ar
      ? `${arabicSpecialties[specialty] ?? "جلسة عيادة"} — ${professional}، ${date}، ${start}–${end}`
      : `${specialty} with ${professional} on ${date}, ${start}–${end}`,
  );
  return ar
    ? `فترات الحضور المنشورة: ${windows.join("؛ ")}. يؤكد الاستقبال الطلبات.`
    : `Published attendance ${cards.length === 1 ? "window" : "windows"}: ${windows.join("; ")}. Reception confirms requests.`;
}
