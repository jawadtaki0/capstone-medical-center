// The button-led flow. No free text and no matcher: every choice is checked
// against published data before anything is shown.
import { laboratoryTests } from "../src/data/labAudioContent.js";
import { arabicLabContent } from "../src/data/publicLabArabic.js";
import { receptionHandoff } from "../src/public-assistant-safety.js";
import { addDays } from "./public-assistant-dates.js";
import {
  clinicWindowFacts,
  eligibleDemoDates,
  publishedHourFacts,
} from "./public-assistant-answerers.js";
import {
  audiometryPreparation,
  publicContent,
} from "./public-assistant-content.js";
import { demoCopy } from "./public-assistant-demo.js";
import { unpublishedPrice } from "./public-assistant-facts.js";
import {
  arabicSpecialty,
  copy,
  renderHours,
  sessionCard,
} from "./public-assistant-render.js";

const words = {
  en: {
    hours: "Which service?",
    doctor: "Which specialty?",
    preparation: "Which test?",
    date: "Choose a date.",
    center: "Center",
    lab: "Laboratory",
    audio: "Audiometry",
  },
  ar: {
    hours: "أي خدمة؟",
    doctor: "أي اختصاص؟",
    preparation: "أي فحص؟",
    date: "اختر تاريخًا.",
    center: "المركز",
    lab: "المختبر",
    audio: "فحوصات السمع",
  },
};
const services = {
  center: { intent: "centerHours", page: "/schedule" },
  lab: { intent: "labHours", page: "/services/laboratory" },
  audio: { intent: "audioHours", page: "/services/audiometry" },
};

export async function guidedMenu(
  menu,
  { lang, today, readHours, readSessions, deadline },
) {
  const text = words[lang];
  const reception = {
    kind: "reception",
    text: receptionHandoff[lang],
    reception: true,
  };
  const options = (question, choices) => ({
    kind: "menu",
    text: question,
    menuOptions: choices.map(([choice, label]) => ({
      topic: menu.topic,
      choice,
      label,
    })),
  });
  const dates = (list) =>
    list.length
      ? { kind: "dateOptions", text: text.date, dateOptions: list, menu }
      : reception;
  const { topic, choice, date } = menu && typeof menu === "object" ? menu : {};

  if (topic === "prices") {
    const { text: answer, page } = unpublishedPrice(lang, false);
    return { kind: "reception", text: answer, page, reception: true };
  }
  if (topic === "register")
    return {
      kind: "library",
      text: publicContent.find(({ id }) => id === "clinic-confirmation-" + lang)
        .answer,
      page: "/schedule",
      reception: true,
    };
  if (topic === "about")
    return {
      kind: "demoIdentity",
      text: demoCopy[lang].identity + " " + demoCopy[lang].creator,
    };

  if (topic === "hours") {
    if (choice === undefined)
      return options(
        text.hours,
        Object.keys(services).map((id) => [id, text[id]]),
      );
    if (!Object.hasOwn(services, choice)) return reception;
    const eligible = await eligibleDemoDates({
      intent: services[choice].intent,
      date: today,
      readHours,
      deadline,
    });
    if (date === undefined) return dates(eligible);
    if (!eligible.includes(date)) return reception;
    const facts = await publishedHourFacts(
      { [choice]: true },
      [date],
      readHours,
      deadline,
    );
    const result = renderHours({ days: facts }, lang);
    return result.complete
      ? {
          kind: "library",
          text: result.text,
          page: services[choice].page,
          reception: true,
        }
      : reception;
  }

  if (topic === "doctor") {
    const week = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    let specialties;
    try {
      const rows = (
        await Promise.all(week.map((day) => readSessions(day, { deadline })))
      ).flat();
      specialties = [
        ...new Set(
          rows
            .filter((row) => row.available !== false && row.published !== false)
            .map((row) => row.specialty)
            .filter((value) => typeof value === "string"),
        ),
      ].sort();
    } catch {
      return reception;
    }
    if (!specialties.length) return reception;
    if (choice === undefined)
      return options(
        text.doctor,
        specialties.map((id) => [id, lang === "ar" ? arabicSpecialty(id) : id]),
      );
    if (!specialties.includes(choice)) return reception;
    const eligible = await eligibleDemoDates({
      intent: "clinicSchedule",
      filters: { specialty: choice },
      date: today,
      readHours,
      readSessions,
      deadline,
    });
    if (date === undefined) return dates(eligible);
    if (!eligible.includes(date)) return reception;
    const { matches } = await clinicWindowFacts({
      days: [date],
      readSessions,
      deadline,
      specialty: choice,
    });
    return matches.length
      ? {
          kind: "sessions",
          text: copy[lang].sessions,
          cards: matches.map(sessionCard),
          reception: true,
        }
      : reception;
  }

  if (topic === "preparation") {
    const name = (test) =>
      lang === "ar" ? arabicLabContent[test.id].name : test.name;
    if (choice === undefined)
      return options(text.preparation, [
        ["audiometry", text.audio],
        ...laboratoryTests.map((test) => [test.id, name(test)]),
      ]);
    if (choice === "audiometry")
      return {
        kind: "library",
        text: audiometryPreparation(lang),
        page: "/services/audiometry",
        reception: true,
      };
    const test = laboratoryTests.find(({ id }) => id === choice);
    if (!test) return reception;
    const local =
      lang === "ar" ? { ...test, ...arabicLabContent[test.id] } : test;
    return {
      kind: "labs",
      text:
        local.name +
        ": " +
        local.preparation +
        (lang === "ar"
          ? " تواصل مع الاستقبال لتأكيد تعليمات طلبك."
          : " Contact Reception to confirm the instructions for your order."),
      page: "/services/laboratory",
      reception: true,
    };
  }
  return reception;
}
