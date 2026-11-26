import { canon } from "./public-assistant-language.js";
import { receptionHandoff } from "../src/public-assistant-safety.js";

export const demoCopy = {
  en: {
    identity:
      "I'm Ask Cedar, the assistant for Cedar's Clinic, Lab and Audiometry services.",
    creator:
      "I was developed by Jawad Taki at LAU for Cedar. Contact: +961 81 814 554 or jawadtaki0@gmail.com.",
    offTopic:
      "I can only help with Cedar's services, hours, doctors and bookings.",
    date: "That date is unavailable. Choose an available date below.",
    noDates: "That date is unavailable. " + receptionHandoff.en,
  },
  ar: {
    identity:
      "أنا اسأل سيدر، مساعد خدمات العيادة والمختبر وفحوصات السمع في سيدر.",
    creator:
      "طوّرني جواد تقي في الجامعة اللبنانية الأميركية لصالح سيدر. للتواصل: ‎+961 81 814 554 أو jawadtaki0@gmail.com.",
    offTopic:
      "يمكنني مساعدتك فقط في خدمات سيدر وساعات العمل والأطباء والحجوزات.",
    date: "هذا التاريخ غير متاح. اختر أحد التواريخ المتاحة أدناه.",
    noDates: "هذا التاريخ غير متاح. " + receptionHandoff.ar,
  },
};

export const creatorQuestion = (message) =>
  /^(?:who (?:made|built|created|developed|programmed) you|who is your (?:creator|developer)|(?:من|مين) (?:صنعك|طورك|برمجك|عملك))[.!?؟\s]*$/u.test(
    canon(message).trim(),
  );

export const standaloneArabizi = (message) =>
  !/\p{Script=Arabic}/u.test(message) &&
  (/(?<=[a-z])[2356789](?=[a-z])|\b[2356789][a-z]+/iu.test(message) ||
    /\b(?:emta|bokra|bukra|moukhtabar|mokhtabar|nhar|dawem|shu|shou|fini|fiye|bye?fta7)\b/iu.test(
      message,
    )) &&
  !/\b(?:what|when|which|how|hours|schedule|price|preparation|booking|open|close|test)\b/iu.test(
    message,
  );

export const symptomRequest = (message) =>
  /\b(?:pain|hurts?|aching|swelling|dizziness|rash|symptoms?|numbness|headache|fever)\b|(?<!\p{L})(?:وجع|الم|دوخه|طفح|تورم|خدر|صداع|اعراض|حراره)(?!\p{L})|بيوجع/u.test(
    canon(message),
  );

export const demoFixedIdentity = (message) =>
  /^(?:who are you|what are you|(?:من|مين) انت)[.!?؟\s]*$/u.test(
    canon(message).trim(),
  );

export function splitDemoRequests(message) {
  return message
    .replace(/\bdr\./giu, "Dr")
    .split(
      /(?:[?؟!;؛]+|(?<!\d)\.(?!\d))\s*|[,،]\s*(?=(?:and |و)?(?:what|when|which|who|how|هل|شو|كيف|وين|قديش)\b)|\s+\band\s+(?=(?:what|when|which|who|how|can|is|are|does)\b)|\s+و(?=شو|كيف|متى|وين|قديش|هل)/iu,
    )
    .map((part) =>
      part
        .trim()
        .replace(/\band\s*$/iu, "")
        .trim(),
    )
    .filter(Boolean);
}
