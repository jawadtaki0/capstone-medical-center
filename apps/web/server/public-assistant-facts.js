import { laboratoryTests } from "../src/data/labAudioContent.js";
import {
  canon,
  confirmationConcept,
  priceConcept,
  requestedProfessional,
} from "./public-assistant-language.js";
import {
  audiometryPreparation,
  publicContent,
} from "./public-assistant-content.js";
import {
  availabilityQuestion,
  scheduleSpecialty,
  serviceLogistics,
} from "./public-assistant-routing.js";

const normalize = (value) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const words = (value) =>
  " " +
  normalize(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() +
  " ";
const audiometryTopic =
  /\b(?:audiometry|hearing (?:tests?|assessment|screening|exam)|sama3)\b|(?:فحص|فحوصات|قسم|اختبار|قياس) (?:ال)?سمع/u;
const specimenPreparation =
  /\b(?:collect(?:ion|ing)?|container|cup|jar|tube|specimen (?:kit|instructions)|sample (?:kit|instructions))\b|(?<!\p{L})(?:ل?جمع|تجميع)(?!\p{L})|وعاء|عبوه|علبه|كوب|انبوب|مرطبان|\b(?:3elbe|3elbeh|kebeye|tajmi3|jame3)\b/u;

export function catalogueIntent(message) {
  const query = words(message);
  const preparationQuery = query.replace(
    /\bfasting (?:blood )?(?:glucose|sugar)\b/g,
    " ",
  );
  const collection = specimenPreparation.test(canon(message));
  const prep =
    collection ||
    /\b(?:prep(?:ar(?:e|ing|ation))?|fast(?:ing)?|abel|before)\b|تحضير|صيام/u.test(
      preparationQuery,
    );
  const ids = laboratoryTests
    .filter(
      ({ id, name, aliases }) =>
        [id, name, name.replace(/\s*\(.*\)/, ""), ...aliases].some((term) =>
          query.includes(words(term)),
        ) ||
        (id === "vitamin-d" &&
          /(?<!\p{L})(?:ال|ل)?فيتامين (?:د|دال)(?!\p{L})/u.test(query)) ||
        (id === "urinalysis" &&
          /(?<!\p{L})ل?تحليل البول(?!\p{L})/u.test(query)) ||
        (id === "urine-culture" &&
          /(?<!\p{L})ل?(?:زرع|زراعه|زراعة|مزرعه|مزرعة)\s+البول(?!\p{L})|\b(?:zare3|zar3|zera3et) (?:el |l )?(?:bawl|bol|boul|baul)\b/u.test(
            query,
          )),
    )
    .map(({ id }) => id);
  if (/\bthyroid\b/.test(query) && /\biron\b/.test(query))
    return { kind: "labs", tests: ["tsh", "free-t4", "ferritin"] };
  if (ids.length && ids.length <= 3 && (prep || ids.length === 1))
    return {
      kind: "labs",
      tests: ids,
      preparation: prep,
      description:
        !collection &&
        (/\b(?:measure|detect|purpose)\b|ماذا يقيس/u.test(query) ||
          (!prep && /\bwhat (?:is|does)\b|ما هو/u.test(query))),
      compare: ids.length > 1,
    };
  return null;
}

export const unpublishedPrice = (language, lab) => ({
  text: lab
    ? language === "ar"
      ? "سعر الفحص غير منشور. تواصل مع الاستقبال للاستفسار عن التكلفة."
      : "Cedar has not published prices for these tests. Contact Reception to ask about costs."
    : language === "ar"
      ? "التكلفة غير منشورة. تواصل مع الاستقبال للاستفسار."
      : "Cedar has not published the cost. Contact Reception to ask about fees.",
  page: lab ? "/services/laboratory" : "/#contact",
  reception: true,
});

export const labBookingAnswer = (language) => ({
  text:
    language === "ar"
      ? "حجز زيارات المختبر غير متاح على الموقع. تواصل مع الاستقبال لتأكيد توفر الفحص وساعات المختبر. لم ينشر سيدر ما إذا كانت الزيارة تتطلب موعدًا أو إحالة أو مستندات محددة."
      : "Online Lab booking is not available. Contact Reception first to confirm test availability and Lab hours. Cedar has not published whether your visit needs an appointment, a referral, or specific documents.",
  page: "/services/laboratory",
  reception: true,
});

export function publicServiceAnswer(value, language, catalogue) {
  const text = normalize(value);
  const canonical = canon(value);
  const library = (text, page, reception = false) => ({
    text,
    page,
    reception,
  });
  const priceQuestion = priceConcept(value);
  if (
    (priceQuestion &&
      !audiometryTopic.test(canonical) &&
      (catalogue ||
        /\b(?:tests?|lab(?:oratory)?|panel|catalogu?e)\b|فحص|تحليل|مختبر|\b(?:fa7s|ta7lil|mokhtabar)\b/u.test(
          canonical,
        ))) ||
    /\banything cheaper\b/u.test(text) ||
    /\b(?:published|catalogue)\b.{0,45}\b(?:fee|price|cost)\b|\b(?:price|cost|cheaper)\b.*\b(?:panel|test)\b|\b(?:panel|tests?)\b.{0,35}\b(?:cost|price|charge)\b/u.test(
      text,
    )
  )
    return { ...unpublishedPrice(language, true), kind: "reception" };
  if (
    priceQuestion &&
    /\b(?:consultation|appointments?|clinic|audiometry|hearing test|visits?|sessions?)\b|معاينه|كشفيه|عياده|موعد|جلسه|السمع/u.test(
      canon(value),
    )
  ) {
    return { ...unpublishedPrice(language, false), kind: "reception" };
  }
  if (
    audiometryTopic.test(canonical) &&
    /\b(?:book(?:ing)?|reserv(?:e|ation)|schedule (?:me|an?|the)|make (?:an? )?appointment|7aj[ez]z?|e7jez|e7jiz)\b|حجز|احجز|بحجز|نحجز/u.test(
      canonical,
    )
  )
    return library(
      publicContent.find(({ id }) => id === "audiometry-booking-" + language)
        .answer,
      "/services/audiometry",
      true,
    );
  if (
    /\b(?:how (?:do|can) i|how to)\s+(?:request|book)\s+(?:an?\s+)?(?:clinic|consultation)\s+(?:session|visit|appointment)\b/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "اختر فترة حضور منشورة للعيادة وأرسل طلبًا. اختيار الفترة لا يحجز موعدًا، ويتولى الاستقبال تأكيد الطلب."
        : "Choose a published Clinic attendance window and submit a request. Choosing a session does not reserve an appointment. Reception confirms requests.",
      "/services/clinic",
    );
  if (
    /\b(?:submit(?:ting)?|send(?:ing)?)\b.{0,36}\b(?:clinic|request) form\b.{0,30}\bconfirm\b/u.test(
      text,
    )
  )
    return library(
      publicContent.find(({ id }) => id === "clinic-confirmation-" + language)
        .answer,
      "/services/clinic",
    );
  if (
    /\b(?:where (?:are you|is cedar) located|what(?:'s| is) (?:your|cedar's) address)\b|اين يقع/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "مركز سيدر في برج البراجنة، بيروت، قرب مكتبة نور الدين."
        : "Cedar is in Bourj El Brajneh, Beirut, near Noureddine Bookshop.",
      "/#contact",
    );
  if (
    /\b(?:your|cedar's|reception'?s?) (?:phone|telephone)(?: number)?\b|رقم الهاتف/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "رقم الهاتف المنشور لمركز سيدر هو +961 81 814 554."
        : "Cedar’s published phone number is +961 81 814 554.",
      "/#contact",
    );
  if (
    serviceLogistics(value) ||
    /\b(?:can i |how (?:do|can) i )?(?:book|reserve) a lab(?:oratory)? visit (?:online|(?:directly )?(?:through|on) .{0,30}website)\b/u.test(
      text,
    )
  )
    return labBookingAnswer(language);
  if (
    audiometryTopic.test(canonical) &&
    /\b(?:prep(?:are|aration)?|get ready|te7dir|ta7dir)\b|تحضير|تحضر|جهز/u.test(
      canonical,
    )
  )
    return library(
      audiometryPreparation(language),
      "/services/audiometry",
      true,
    );
  if (
    specimenPreparation.test(canonical) &&
    /\b(?:urine|stool|specimen|sample|lab(?:oratory)?|blood test)\b|بول|براز|عينه|مختبر/u.test(
      canonical,
    ) &&
    !catalogue
  )
    return {
      ...library(
        language === "ar"
          ? "تواصل مع الاستقبال لتأكيد طريقة جمع العينة والوعاء المطلوبين قبل جمعها."
          : "Contact Reception before collecting to confirm the collection method and container required for your order.",
        "/services/laboratory",
        true,
      ),
      kind: "reception",
    };
  if (
    (confirmationConcept(value) ||
      /\b(?:where (?:does|will) the request go|who (?:handles|confirms|approves) (?:the |a )?request)\b/u.test(
        canonical,
      )) &&
    /\b(?:appointment|session|slot|window|booking|clinic|request)\b|جلسه|موعد|حجز|العياده|طلب/u.test(
      canonical,
    )
  ) {
    return library(
      language === "ar"
        ? "اختيار جلسة منشورة لا يحجز موعدًا. أرسل الطلب، ويتولى الاستقبال تأكيده."
        : "Choosing a session does not reserve an appointment. Submit a request and Reception will confirm it.",
      "/services/clinic",
    );
  }
  if (
    /\bwhat the laboratory offers\b|\bwhat does the lab(?:oratory)? offer\b/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "تعرض صفحة المختبر فحوصات الدم والبول والبراز ومعلومات عامة عن التحضير. تواصل مع الاستقبال لتأكيد توفر الفحص وتعليمات طلبك."
        : "Cedar’s Laboratory page lists blood, urine and stool tests with general preparation information. Contact Reception to confirm a test’s availability and instructions for your order.",
      "/services/laboratory",
      true,
    );
  if (/\b(?:summari[sz]e|overview of)\b.*\bwhat cedar offers\b/u.test(text))
    return library(
      language === "ar"
        ? "ينشر سيدر فترات حضور العيادة ويتيح إرسال طلبات يؤكدها الاستقبال. ينشر المختبر دليل الفحوصات ومعلومات عامة عن التحضير. وتشرح صفحة فحوصات السمع اختبارات السمع والأذن الوسطى."
        : "Cedar publishes Clinic attendance windows and accepts requests that Reception confirms. The Laboratory publishes a test catalogue and general preparation information. The Audiometry page describes hearing and middle-ear tests.",
      "/",
    );
  if (
    /\b(?:unhappy|concerned|complaint)\b.*\b(?:wait(?:ed|ing)?|visit|service)\b/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "نأسف لأن الانتظار كان مزعجًا. تواصل مع الاستقبال لمناقشة ما حصل. لم ينشر سيدر إجراءً منفصلًا للشكاوى."
        : "I’m sorry the wait was frustrating. Contact Reception to discuss what happened. Cedar has not published a separate complaint process.",
      "/#contact",
      true,
    );
  if (
    /اطلب جلسة.*العيادة|طلب جلسة.*العيادة|(?:بطلب|اطلب|طلب).{0,22}جلسة منشورة/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "اختر جلسة منشورة للعيادة، ثم افتح نموذج الطلب وأرسل طلبك. يتولى الاستقبال تأكيد الطلب."
        : "Choose a published Clinic session, open the request form and submit your request. Reception confirms requests.",
      "/services/clinic",
    );
  if (/النغمات النقية/u.test(text) && /طبلة الاذن/u.test(text))
    return library(
      publicContent
        .filter(({ id }) =>
          [
            "audiometry-pure-tone-" + language,
            "audiometry-tympanometry-" + language,
          ].includes(id),
        )
        .map(({ answer }) => answer)
        .join(" "),
      "/services/audiometry",
    );
  return null;
}

export const closingQuestion =
  /\b(?:close|closes|closing|shut(?:s|ting)?|(?:b(?:ye?|y)?|y)?s[ae]kk[ei]r)\b|\b(?:la|la7ad) ay(?:ya)? se3a\b|stop (?:receiving|seeing) (?:visitors|patients)|\b(?:bi2fol|bye2fal)\b|يغلق|اغلاق|اقفال|يقفل|بيقفل|بيسكر|يسكر|بخلص|بيخلص|بيضل شغال|(?:لحد|حتى) اي ساع[هة]|اخر ساع[هة]/iu;

export function hoursQuestion(value) {
  const text = canon(value);
  const lab =
    /\b(?:lab(?:oratory)?|blood test|mokhtabar|moukhtabar)\b|مختبر/u.test(text);
  const audio = audiometryTopic.test(text);
  const clinic = /\bclinic\b|العياده/u.test(text);
  const center =
    /\b(?:cent(?:er|re)|(?:the |main |cedar(?:'s)? )building|marka[sz])\b|المركز|المبنى الرئيسي/u.test(
      text,
    );
  const when =
    /\b(?:hours|open(?:ing)?|clos(?:e|es|ing)|until when|what time|when|emta|aymta|daw[ae]m|weekend|tomorrow|bukra|bokra|saturday|plan.*morning|byesakkir|byesakker|bysakkir)\b|\b(?:bye?fta7|mafta7|maftou7|maftu7|fet[iy]7|fetih)\b|متى|امتى|ايمتى|اي ساعه|يفتح|فاتح|بيبلش|بيبدا|يغلق|مفتوح|مسكر|\bmsakkar\b|دوام|ساعات|(?:ب?تشتغل|شغال|يستقبل|بتستقبل)|الاحد|السبت|بكرا/u.test(
      text,
    );
  if (!when && !closingQuestion.test(text) && !(lab && audio)) return null;
  if (lab || audio) return { lab, audio, center: clinic, weekend: false };
  if (
    center ||
    (clinic &&
      !scheduleSpecialty(value) &&
      (closingQuestion.test(text) ||
        /\b(?:hours|open(?:ing|s)?|dawam|bye?fta7)\b|دوام|ساعات|يفتح/u.test(
          text,
        )))
  )
    return { center: true, weekend: /weekend/.test(text) };
  if (
    /\bopening hours\b|\bopen this weekend\b|\b(?:centre|center|cedar)\b.{0,15}\bopen\b|ساعات (?:عمل )?المركز/u.test(
      text,
    )
  )
    return { center: true, weekend: /weekend/.test(text) };
  return null;
}

export function combinedRequestParts(message) {
  const clauses = message.split(
    /(?:,\s*)?\band\b|[?؟;؛]\s*|،\s*و?|,\s*(?=و)|\s+و(?=امتى|إمتى|متى|اي ساعة|أي ساعة|اللاب|المختبر|بنفس)/iu,
  );
  const session = clauses.findIndex(
    (part) =>
      !hoursQuestion(part) &&
      (scheduleSpecialty(part) || requestedProfessional(part)) &&
      (availabilityQuestion(part) ||
        /\b(?:clinic|sessions?|slots?)\b|عياد|جلسه/iu.test(part)),
  );
  const hours = clauses.findIndex((part) => hoursQuestion(part));
  if (session < 0 || hours < 0 || session === hours) return null;
  return {
    session: clauses[session],
    hours: clauses[hours],
    hoursFirst: hours < session,
  };
}
