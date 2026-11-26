import { specialtyDefinitions } from "../src/data/specialties.js";
import { canon, requestedProfessional } from "./public-assistant-language.js";
import { protectedGate } from "./public-assistant-gate.js";
export {
  emergencyDisclosure,
  rulesCopy,
  serviceLogistics,
} from "./public-assistant-gate.js";
import {
  resolveDay,
  scheduleText,
  scheduleTime,
} from "./public-assistant-dates.js";

export {
  relativeDay,
  resolveDay,
  sameDayReference,
  scheduleTime,
} from "./public-assistant-dates.js";

const normalize = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064b-\u065fـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[’‘]/g, "'");

export function localRoute(message) {
  const category = protectedGate(message);
  return category === "cancel" ? "private" : (category ?? socialRoute(message));
}

export function socialRoute(message) {
  const text = normalize(message);
  if (
    /^(?:hi|hello|hey|good morning|مرحبا|اهلا|صباح الخير|mar7aba|sabah el kheir)[\s!.؟?]*$/u.test(
      text,
    )
  )
    return "greeting";
  if (
    /^(?:thanks|thank you|thx|شكرا|يسلمو|shukran|merci)[\s!.؟?]*$/u.test(text)
  )
    return "thanks";
  return null;
}

export const identityQuestion = (value) =>
  /\b(?:who are you|what are you|what can you do|are you (?:a bot|human|cedar))\b|من انت|مين انت|هل انت روبوت|meen ent[ae]|min ent[ae]/iu.test(
    normalize(value),
  );
export function scheduleSpecialty(value) {
  const text = scheduleText(value);
  const heart =
    /\bcardiolog(?:y|ist)\b|\bheart\s+(?:doctor|specialist)\b|(?<!\p{L})(?:ال)?قلب(?!\p{L})|\b(?:2alb|al[bp])\b/u.test(
      text,
    );
  const skin =
    /\bdermatolog(?:y|ist)\b|\bskin\s+(?:doctor|specialist)\b|جلدي[هة]|\b(?:jildiy[ae]|jeldiy[ae])\b/u.test(
      text,
    );
  const padded = " " + text.replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
  const matches = new Set(
    specialtyDefinitions
      .filter(({ aliases }) =>
        aliases.some((alias) =>
          padded.includes(
            " " +
              canon(alias)
                .replace(/[^\p{L}\p{N}]+/gu, " ")
                .trim() +
              " ",
          ),
        ),
      )
      .map(({ label }) => label),
  );
  if (heart) matches.add("Cardiology");
  if (skin) matches.add("Dermatology");
  if (/\bpediatrics?|pediatrician\b|اطفال/u.test(text))
    matches.add("Pediatrics, Neonatology, and General Health");
  if (/\b(?:dentists?|dental)\b|اسنان/u.test(text)) matches.add("Dentistry");
  const colloquial = {
    pediatrics:
      /\b(?:child(?:ren)?'s|kids?) (?:clinic|doctor|specialist)\b|(?:عياده|طبيب|دكتور) (?:ال)?(?:اطفال|ولاد)/u,
    endocrinology:
      /\b(?:diabetes|thyroid|hormones?) (?:clinic|doctor|specialist)\b|(?:عياده|طبيب|اختصاصي) (?:ال)?غدد/u,
    "speech-therapy":
      /\b(?:speech|swallowing) therap(?:y|ist)\b|(?:علاج|اختصاصي) (?:ال)?نطق/u,
    gynecology: /نسائي[هة]|طبيب نسا|دكتور نسا|\b(?:nisa2iya|nisa2iyye)\b/u,
    ophthalmology:
      /\beye (?:clinic|doctor|specialist|surgeon|surgery)\b|طبيب (?:عيون|العيون)|دكتور عيون/u,
    urology: /(?:ال)?مسالك(?: بولي[هة])?|\burinary specialist\b/u,
    dietitian:
      /اختصاصي[هة]? (?:ال)?تغذي[هة]|اخصائي[هة]? (?:ال)?تغذي[هة]|\bnutritionist\b/u,
    ent: /\bear (?:doctor|specialist)\b|(?:انف|اذن)(?:\s*و\s*(?:ال)?اذن)?\s*و?\s*حنجر[هة]|(?:ال)?انف\s*و\s*(?:ال)?اذن|\b7akim wedan\b/u,
    surgery: /\bgeneral surgeon\b|جراح عام|جراح[هة] (?:ال)?عام[هة]/u,
    gastroenterology:
      /\bgastro (?:doctor|clinic|specialist)\b|(?:طبيب|دكتور) جهاز هضمي/u,
  };
  for (const { id, label } of specialtyDefinitions)
    if (colloquial[id]?.test(text)) matches.add(label);
  if (
    matches.has("Ophthalmology & Eye Surgery") &&
    /\beye surgery\b/u.test(text) &&
    !/\bgeneral surg/u.test(text)
  )
    matches.delete("General Surgery");
  return matches.size === 1 ? [...matches][0] : "";
}

export const availabilityQuestion = (value) => {
  const message = scheduleText(value);
  return (
    (scheduleSpecialty(message) ||
      /\b(?:sessions?|slots?|appointments?|doctors?|doktor|daktor|specialist|cardiology|dermatology|clinic)\b|جلس[هةات]|موعد|مواعيد|عياد[هة]|طبيب|دكتور|قلب|جلدي|maw3ad|doctor|7ajz/iu.test(
        message,
      )) &&
    (Object.keys(scheduleTime(message)).length > 0 ||
      /\b(?:available|availability|listed|on (?:the|.{0,20}published) schedule|open|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|when|can i see|could i see|find|show|are there|any|next|book)\b|اليوم|بكرا|غد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمع[هة]|السبت|الاحد|متى|هل يوجد|في مواعيد|متاح|f[iy]|bukra|boukra|bokra|lyom|emta|\d{4}-\d{2}-\d{2}/iu.test(
        message,
      ))
  );
};
export const refinementQuestion = (value) =>
  /^(?:(?:actually|instead|and|what about|how about|could i go|can i come|anything)[,\s]+)?(?:only|after|before|any later|(?:in the )?(?:afternoon|morning)|tomorrow|today|(?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|later|earlier|بس|فقط|بعد|قبل|الصبح|بكرا|غدا|هل يوجد وقت|وقتا|ba3d|bas|bokra|bukra|boukra|lyom)/iu.test(
    scheduleText(value),
  );
export const specialtyCorrection = (value) =>
  /^(?:actually|instead|what about|how about)[,\s]+|\binstead[?.!]*$/u.test(
    scheduleText(value),
  );
export const genericArabiziAvailability = (value) =>
  /^(?:(?:f[iy]|doctor|doktor|daktor|bokra|bukra|boukra|lyom|emta|maw3ad|pls)\b\s*)+[?.!؟]*$/u.test(
    scheduleText(value),
  );
export function scheduleRequest(
  message,
  today,
  day = resolveDay(message, today),
) {
  const specialty = scheduleSpecialty(message);
  return {
    ...day,
    specialty,
    time: scheduleTime(message),
    clinician:
      (!specialty && requestedProfessional(message)) ||
      /\b(?:dr\.?|doctor)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}?)\s+(?:available|listed|in|for|on (?:(?:the )?published(?: [\p{L}]+)?|the|[\p{L}'’-]+(?:’s|'s)? published) schedule)\b/iu.exec(
        message,
      )?.[1] ||
      /\b(?:surname|last name)\s+([\p{L}][\p{L}'’-]*)/iu.exec(message)?.[1],
    availability:
      availabilityQuestion(message) ||
      (Boolean(day.day) &&
        Boolean(specialty) &&
        /\b(?:schedule|windows?|sessions?|slots?|list|include|appointments?)\b|جلس[هة]|مواعيد|عياد/u.test(
          scheduleText(message),
        )),
  };
}
