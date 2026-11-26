import { laboratoryTests } from "../src/data/labAudioContent.js";
import { catalogueIntent } from "./public-assistant-facts.js";
import {
  canon,
  nameTokens,
  priceConcept,
} from "./public-assistant-language.js";

const publicHours =
  /\b(?:hours|open(?:s|ing)?|clos(?:e[sd]?|ing)|daw[ae]m|maftou?7|bye?fta7|byes[ae]kk[ei]r)\b|ساعات|دوام|مفتوح|يفتح|بيفتح|فاتح|اغلاق|اقفال|يغلق|بيقفل|يسكر|بيسكر|مسكر/u;
const publicRequestOpening =
  /^(?:\b(?:what|when|which|how|is|are|does|do|should|must|can|could|any|please|show|list|give|tell|check|find|lab|laboratory|clinic|cent(?:er|re)|cedar|open(?:ing)?|audiometry|hearing|dr|doctor|hours|emta|aymta|shu|shou|ade|adde|addesh|2adesh|fiy?a?|ay|hal|daw[ae]m|lab[o]?|sama3|la7ad)\b|(?:هل|متى|امتى|ايمتى|كيف|قديش|كم|شو|في |فيني|وين|اي |عندكن|عندكم|العياده|المختبر|اللاب|المركز|فحوصات السمع|ساعات|دوام))/u;
const publicPriceSubject =
  /\b(?:lab(?:oratory)?|clinic|consultation|audiometry|hearing test|mokhtabar|sama3)\b|المختبر|العياده|كشفيه|معاينه|السمع/u;
const preparationWording =
  /\b(?:prepar(?:e|ation)|get ready|fasting|fast|collect(?:ion)?|container|specimen|ta7dir|te7dir|siyam|3elbe)\b|تحضير|جهز|جمع|وعاء|صيام|صوم|علبه/u;
const hearingPreparation =
  /\b(?:audiometry|hearing (?:test|assessment|exam))\b|(?:فحص|اختبار|فحوصات) السمع/u;
const bareClinic =
  /^(?:(?:please )?(?:show(?: me)?|list|any|are there|what are) )?(?:published )?clinic (?:sessions?|windows?|slots?)(?:\s|$)/u;

function singleRequest(value) {
  const text = canon(value)
    .trim()
    .replace(/\bdr\./gu, "dr")
    .replace(/[.!?؟]+\s*$/u, "");
  // A second request or personal context needs a human even when one clause
  // contains a service keyword. Keep the original text for the protected gate.
  if (
    /[.!?؟؛;،\n\r"“”«»]/u.test(text) ||
    /(?:^|\s)'[^']+'(?:\s|$)/u.test(text) ||
    /\b(?:and|or|but|because|so that|since (?:i|my|we|he|she|they)|after (?:i|my|we|he|she|they)|while (?:i|my|we|he|she|they)|if (?:i|my|we|he|she|they)|without knowing)\b|(?:لانه|لاني|بس اذا|كرمال|ولكن)/u.test(
      text,
    )
  )
    return "";
  return text;
}

export function isPublicFastingQuestion(value) {
  const text = singleRequest(value);
  const query =
    /^(?:(?:do|should|must) i (?:need to )?fast (?:for|before)|is fasting (?:needed|required) (?:for|before)|(?:لازم|هل لازم) (?:صوم|اصوم) (?:قبل|ل))\s+(.+)$/u.exec(
      text,
    );
  if (!query || !catalogueIntent(value)?.preparation) return false;
  // Exempt only an exact named catalogue test. A personal qualifier or a
  // medication question remains under the clinical gate's existing rules.
  return laboratoryTests.some(({ id, name, aliases }) =>
    [id, name, name.replace(/\s*\(.*\)/u, ""), ...aliases].some(
      (term) => canon(term) === query[1].replace(/^(?:a|an|the) /u, ""),
    ),
  );
}

export function confidentPublicRequest(message, classified) {
  const text = singleRequest(message);
  if (!text || classified.booking || classified.combinedSchedule) return false;
  if (
    /\b(?:for|with) (?:my|me|children|kids|an emergency|walk-ins?|a referral|insurance)\b/u.test(
      text,
    )
  )
    return false;
  const asks = publicRequestOpening.test(text);
  switch (classified.kind) {
    case "hours":
      return (
        publicHours.test(text) &&
        (asks ||
          /^(?:[\p{L}\p{N}]+\s+){0,3}(?:saturday|sunday|monday|tuesday|wednesday|thursday|friday)'?s?(?:\s|$)/u.test(
            text,
          ))
      );
    case "reference":
      return (
        asks &&
        ((classified.route === "reception" &&
          priceConcept(text) &&
          (publicPriceSubject.test(text) ||
            catalogueIntent(message)?.tests.length === 1)) ||
          (classified.route === "library" &&
            classified.fields.page === "/services/audiometry" &&
            hearingPreparation.test(text) &&
            preparationWording.test(text)))
      );
    case "labs":
      return (
        classified.lab.preparation === true &&
        classified.lab.tests.length === 1 &&
        preparationWording.test(text) &&
        (asks ||
          /^(?:prepar(?:e|ation)|fasting|sample|container|تحضير|جمع|صيام)/u.test(
            text,
          ))
      );
    case "sessions":
      return Boolean(
        classified.day &&
        !classified.refinement &&
        (classified.namedProfessional
          ? nameTokens(classified.namedProfessional).length >= 2
          : classified.specialtyHint || bareClinic.test(text)) &&
        asks,
      );
    default:
      return false;
  }
}
