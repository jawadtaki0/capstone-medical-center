import {
  audiometryEntries,
  audiometryFaqs,
  laboratoryFaqs,
} from "../src/data/labAudioContent.js";

export const audiometryPreparation = (language) =>
  language === "ar"
    ? "لا تحتاج فحوصات السمع الروتينية عادةً إلى تحضير خاص. أكّد تعليمات زيارتك مع الاستقبال."
    : audiometryFaqs[1][1];

const reviewed = "2026-11-24";
const pair = (id, topic, en, ar) =>
  [en, ar].map(([questions, answer], i) => ({
    id: id + "-" + (i ? "ar" : "en"),
    language: i ? "ar" : "en",
    topic,
    questions,
    answer,
    lastReviewed: reviewed,
  }));

export const publicContent = [
  ...pair(
    "clinic-confirmation",
    "clinic",
    [
      [
        "who confirms",
        "how do clinic requests work",
        "how does booking work",
        "appointment requests",
        "request confirmation",
        "7ajz bl clinic",
      ],
      "Choose a published Clinic attendance window and submit a request. Reception confirms the booking.",
    ],
    [
      ["من يؤكد", "كيف أحجز في العيادة", "كيف يعمل الحجز", "تأكيد الطلب"],
      "اختر موعد حضور منشورًا للعيادة وأرسل طلبًا. يؤكد الاستقبال الحجز.",
    ],
  ),
  ...pair(
    "clinic-session-window",
    "clinic",
    [
      [
        "exact consultation time",
        "what is an attendance window",
        "when will the doctor see me",
      ],
      "The published window is for attendance. It does not specify an exact consultation time.",
    ],
    [
      ["ما معنى فترة الحضور", "وقت المعاينة بالضبط"],
      "الفترة المنشورة هي فترة الحضور، ولا تحدد وقت المعاينة بدقة.",
    ],
  ),
  ...pair(
    "lab-booking",
    "laboratory",
    [
      [
        "book a lab",
        "book a laboratory",
        "schedule a lab visit",
        "lab appointment online",
        "lab booking",
        "7ajz mokhtabar",
      ],
      laboratoryFaqs[3][1],
    ],
    [
      ["أحجز للمختبر", "حجز المختبر", "موعد المختبر عبر الموقع"],
      "حجز زيارات المختبر غير متاح على الموقع. تواصل مع الاستقبال للتفاصيل.",
    ],
  ),
  ...pair(
    "audiometry-booking",
    "audiometry",
    [
      [
        "book a hearing test",
        "book audiometry",
        "audiometry appointment",
        "schedule a hearing assessment",
      ],
      audiometryFaqs[0][1],
    ],
    [
      ["حجز فحص السمع", "أحجز فحص السمع", "موعد لفحص السمع"],
      "حجز فحوصات السمع غير متاح على الموقع. تواصل مع الاستقبال لتفاصيل الزيارة.",
    ],
  ),
  ...pair(
    "audiometry-pure-tone",
    "audiometry",
    [
      ["pure tone", "pure-tone", "hearing beeps", "what is audiometry"],
      audiometryEntries[0].description,
    ],
    [
      ["النغمات النقية", "ما هو قياس السمع", "فحص السمع بالنغمات"],
      "يستخدم فحص النغمات النقية أصواتًا بترددات ومستويات مختلفة لتقييم حساسية السمع.",
    ],
  ),
  ...pair(
    "audiometry-speech",
    "audiometry",
    [
      ["speech testing", "speech hearing test", "why use spoken words"],
      audiometryEntries[1].description,
    ],
    [
      ["اختبار الكلام", "فحص السمع بالكلام"],
      "يستخدم اختبار الكلام كلمات منطوقة لتقييم كيفية سماع الكلام.",
    ],
  ),
  ...pair(
    "audiometry-tympanometry",
    "audiometry",
    [
      ["tympanometry", "eardrum movement", "middle ear function"],
      audiometryEntries[2].description,
    ],
    [
      ["قياس الطبلة", "حركة طبلة الأذن", "وظيفة الأذن الوسطى"],
      "يقيّم قياس الطبلة حركة طبلة الأذن ووظيفة الأذن الوسطى، ولا يغني عن قياس عتبات السمع.",
    ],
  ),
];

const normalize = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064b-\u065fـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .trim();
export function reviewedMatch(value, language) {
  const message = normalize(value);
  const matches = publicContent.filter(
    (entry) =>
      entry.language === language &&
      entry.questions.some((variant) => message.includes(normalize(variant))),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function publishedAnswer(value, lang) {
  const text = normalize(value);
  const ar = lang === "ar";
  const answer = (text, topic, reception = false) => ({
    text,
    topic,
    reception,
  });
  if (
    /\b(?:how (?:do|can) i|how to) (?:book|request) (?:an? )?appointment\b|كيف احجز موعد/u.test(
      text,
    )
  )
    return answer(
      ar
        ? "اختر موعد حضور منشورًا وأرسل طلبًا. يتولى الاستقبال تأكيد الطلب."
        : publicContent[0].answer,
      "clinic",
    );
  if (/\bwhat clinics\b|\bwhich clinics\b/u.test(text))
    return answer(
      ar
        ? "يعرض جدول سيدر المنشور معاينات العيادة بحسب الاختصاص، ويعرض المختبر وفحوصات السمع بشكل منفصل."
        : "Clinic consultations are listed by specialty in Cedar’s published schedule. Laboratory and Audiometry are listed separately.",
      "clinic",
    );
  if (
    /\b(?:what|which) lab tests.*(?:offer|available)|ما هي الفحوصات المتوفر[هة] في المختبر/u.test(
      text,
    )
  )
    return answer(
      ar
        ? "يمكنك الاطلاع على الفحوصات المنشورة في دليل المختبر. تواصل مع الاستقبال لتأكيد توفر الفحص."
        : "See Cedar’s published Lab catalogue for the tests listed online. Contact Reception to confirm availability.",
      "laboratory",
    );
  if (/fast for a blood sugar test|الصيام قبل فحص الدم/u.test(text))
    return answer(
      ar
        ? "يعتمد التحضير على الفحص المحدد. تواصل مع الاستقبال لتأكيد تعليمات طلبك."
        : "Preparation depends on the specific test. Fasting glucose requires fasting. Contact Reception to confirm the instructions for your order.",
      "laboratory",
      true,
    );
  if (/\blab test.*appointment|\bappointment for a lab test\b/u.test(text))
    return answer(
      ar
        ? "لا يمكن حجز زيارة المختبر عبر الموقع. لم ينشر سيدر ما إذا كانت الزيارة تتطلب موعدًا. تواصل مع الاستقبال."
        : "Online Lab booking is not available. Cedar has not published whether your Lab visit requires an appointment. Contact Reception.",
      "laboratory",
      true,
    );
  if (/\b(?:do you|does cedar) (?:do|offer) hearing tests\b/u.test(text))
    return answer(
      ar
        ? "ينشر سيدر معلومات عن فحوصات السمع، ومنها قياس السمع بالنغمات النقية وفحص الكلام وقياس الطبلة."
        : "Cedar publishes Audiometry information, including pure-tone audiometry, speech testing and tympanometry.",
      "audiometry",
    );
  if (/\bhearing test.*(?:preparation|prepare)\b/u.test(text))
    return answer(audiometryFaqs[1][1], "audiometry");
  const missing = [
    [
      /\bhow long.*lab results|\blab.*turnaround\b/u,
      "Lab result turnaround times",
    ],
    [/\bwhat should i bring.*lab\b/u, "what to bring to a Lab visit"],
    [
      /\b(?:children|child|pediatric).*hearing|hearing.*(?:children|child|pediatric)\b/u,
      "whether Audiometry is available for children",
    ],
    [/\b(?:do you|does cedar) (?:do|offer) mri\b/u, "MRI service information"],
    [/\b(?:how much|price|cost).*blood test\b/u, "blood test prices"],
  ].find(([pattern]) => pattern.test(text));
  if (missing)
    return answer(
      "Cedar’s public information does not include " +
        missing[1] +
        ". This detail is not published. Contact Reception.",
      null,
      true,
    );
  return null;
}
