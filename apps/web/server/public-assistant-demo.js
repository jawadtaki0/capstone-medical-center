import { fixedIntentExamples } from "./public-assistant-fixed-bank.js";
import { canon } from "./public-assistant-language.js";
import { cedarToday, resolveDay } from "./public-assistant-dates.js";
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
    unread: "I couldn’t read that date. Choose a date below.",
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
    unread: "لم أتمكن من قراءة التاريخ. اختر تاريخًا أدناه.",
    noDates: "هذا التاريخ غير متاح. " + receptionHandoff.ar,
  },
};

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
  /\b(?:pain|hurts?|aching|swelling|dizziness|rash|symptoms?|numbness|headache|fever)\b|(?<!\p{L})(?:وجع|الم|دوخه|طفح|تورم|خدر|صداع|اعراض|حراره)(?!\p{L})|بيوجع|(?:^|\s)ب(?:وجع|الم)(?!\p{L})/u.test(
    canon(message),
  );

const phraseKey = (message) =>
  canon(message)
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
const bank = Object.fromEntries(
  Object.entries(fixedIntentExamples).flatMap(([id, messages]) =>
    messages.map((message) => [phraseKey(message), id]),
  ),
);
const assistantSubject =
  /\b(?:assistant|chatbot|this chat|this tool|you|your)\b|المساعد|مساعد|الدردشه|دردشه|اداه|برنامج|انت|حضرتك/u;
const creator =
  /\b(?:who|author|creator|developer|behind)\b.{0,75}\b(?:built|coded|programmed|made|created|developed|designed|wrote|behind|creator|developer|author)\b|\b(?:creator|developer|author)\s+(?:of|behind)\b|(?:مين|من|الشخص).{0,35}(?:طور|صمم|برمج|عمل|صنع|كتب|مبرمج)|(?:كيف|وين).{0,30}(?:تواصل|لاقي).{0,30}(?:طور|صمم|برمج)|(?:مطور|مصمم|مبرمج) (?:هال)?(?:مساعد|دردشه|اداه|برنامج)/u;
const identity =
  /\b(?:who are you|what are you|who am i (?:talking|speaking|chatting) (?:to|with)|introduce yourself|(?:your|assistant'?s) name|what (?:kind of )?assistant|which (?:cedar )?(?:assistant|helper)|what should i call|what (?:can|do) you (?:do|help))\b|(?:مين|من) (?:انت|حضرتك|هالمساعد)|حضرتك مين|(?:تعرف|عرفني) (?:عن نفسك|عن حالك|مين)|شو (?:اسمك|اسم المساعد|دورك|منسميك)/u;
const unrelated =
  /\b(?:capital of|wedding playlist|sandwich recipe|home renovation)\b|عاصمه|تذكر[هة] الطيار[هة]|تزيين الصالون|اقتراح فيلم|اقترح فيلم/u;

export function fixedDemoIntent(message, gateCategory) {
  const text = phraseKey(message);
  if (
    (assistantSubject.test(text) && creator.test(text)) ||
    /^(?:مين|من) (?:طورك|برمجك|صممك|عملك|صنعك)$/u.test(text)
  )
    return "creator";
  if (identity.test(text)) return "identity";
  const match = bank[text];
  if (match) return match;
  return gateCategory === "unrelated" || unrelated.test(text)
    ? "offTopic"
    : null;
}

const asksSomething =
  /\b(?:what|when|which|who|how|is|are|can|do|does|hours?|open\w*|clos\w*|price|cost|book\w*|prepar\w*|results?)\b|شو|قديش|متي|امتي|كيف|هل|وين|مين|اي ساعه|دوام|ساعات|سعر|فحص|نتيج/u;

// "I'm coming Friday. When do you close?" is one request: keep its date.
export function mergeDateNotes(sentences) {
  const merged = [];
  let note = "";
  for (const sentence of sentences) {
    const text = canon(sentence);
    if (!asksSomething.test(text) && resolveDay(text, cedarToday()).specified) {
      note = (note + " " + sentence).trim();
      continue;
    }
    merged.push((note + " " + sentence).trim());
    note = "";
  }
  if (note) merged.push([merged.pop(), note].filter(Boolean).join(" "));
  return merged;
}

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
