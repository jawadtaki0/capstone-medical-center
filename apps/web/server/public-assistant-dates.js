import { canon, correctTypos } from "./public-assistant-language.js";

export const addDays = (date, offset) => {
  const day = new Date(date + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
};
export const cedarToday = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Beirut" }).format(now);

export const scheduleText = (value) =>
  correctTypos(
    canon(value)
      .replace(/\b(?:tomorow|tomoorow|tommorow|tommorrow|tmrw)\b/g, "tomorrow")
      .replace(/\bdr\.?\b/g, "doctor")
      .replace(/\bspecalist\b/g, "specialist")
      .replace(/\bcardiolgy\b/g, "cardiology")
      .replace(/\bsesions\b/g, "sessions")
      .replace(/\bthursdy\b/g, "thursday")
      .replace(/\b(?:satuday|satruday|satudray|sabet|sabt)\b/g, "saturday")
      .replace(/\bpediatrcs\b/g, "pediatrics")
      .replace(/\bgastroentrology\b/g, "gastroenterology")
      .replace(/\bgastroentrologist\b/g, "gastroenterologist")
      .replace(/\bfryday\b/g, "friday")
      .replace(/\bgynecolgy\b/g, "gynecology")
      .replace(/\bwindw\b/g, "window")
      .replace(/\b(?:nhar l )?(?:a7ad|ahad)\b/g, "sunday")
      .replace(/\btuesdy\b/g, "tuesday")
      .replace(/\burolojy\b/g, "urology")
      .replace(/(?:الثلاثا(?![ء\p{L}])|التلات[اه](?!\p{L}))/gu, "الثلاثاء")
      .replace(/\b(?:nhar l )?(?:etnen|etnein|tnen)\b/g, "monday")
      .replace(
        /\b(?:opthalmolgy|opthalmology|ophthalmolgy)\b/g,
        "ophthalmology",
      )
      .replace(/\b(?:jom3a|jem3a|j[ou]m3a)\b/g, "friday")
      .replace(/\b(?:tlate|tlete|tlata)\b/g, "tuesday")
      .replace(/\b(?:arba3a|arb3a|arbe3a)\b/g, "wednesday")
      .replace(/\b(?:khamis|khamees|5amis)\b/g, "thursday")
      .replace(/(?<!\p{L})(?:ال)?(?:تلاتا|تلاته|ثلاثا)(?!\p{L})/gu, "الثلاثاء")
      .replace(
        /(?<!\p{L})(?:ال)?(?:خميس|جمعه|اربعا|سبت|اتنين|تنين)(?!\p{L})/gu,
        (day) =>
          ({
            خميس: "الخميس",
            جمعه: "الجمعة",
            اربعا: "الاربعاء",
            سبت: "السبت",
            اتنين: "الاثنين",
            تنين: "الاثنين",
          })[day.replace(/^ال/u, "")],
      ),
  );

export function scheduleTime(value) {
  const numbers = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ];
  const text = scheduleText(value)
    .replace(
      /\b((?:after|before|past|to|at)\s+)(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
      (_, prefix, word) => prefix + (numbers.indexOf(word) + 1),
    )
    .replace(/\bhalf past (\d{1,2})\b/g, "$1:30")
    .replace(/\bquarter past (\d{1,2})\b/g, "$1:15")
    .replace(
      /\bquarter to (\d{1,2})\b/g,
      (_, hour) => ((Number(hour) + 22) % 12) + 1 + ":45",
    )
    .replace(
      /\b(?:earlier in the day|earlier (?:please|if possible))\b/g,
      "before noon",
    )
    .replace(
      /\b(?:start(?:s|ing)? at|starts? from)\s+(\d{1,2}(?::[0-5]\d)?)(?:\s+(?:(?:in the )?afternoon|p\.?m\.?))?\s+or later\b/g,
      (_, clock) =>
        "start after " +
        clock +
        (/\b(?:afternoon|p\.?m\.?)/u.test(value) &&
        Number(clock.split(":")[0]) < 12
          ? " pm"
          : ""),
    )
    .replace(/\b(?:later than|not before)\b/g, "after")
    .replace(/\b(?:earlier than|no later than)\b/g, "before");
  if (
    /\b(?:drop|remove|clear|without)\b.{0,22}\b(?:morning|afternoon|time)\b|\bany time\b/u.test(
      text,
    )
  )
    return { after: "", before: "" };
  const noon = /\b(after|before) noon\b/u.exec(text);
  if (/\bbefore eleven(?: in the morning)?\b/u.test(text))
    return { after: "", before: "11:00" };
  if (noon) return { after: "", before: "", [noon[1]]: "12:00" };
  const match =
    /(?:\b(after|before|ba3d|abel|2abel)\s+|(?:بعد|قبل)\s+)(?:(?:الساعه|l|el)\s+|ال\s*)?(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|صباحا?|مساء?)?(?![\d:])/u.exec(
      text,
    );
  if (match) {
    const [, , hours, minutes = "00", period] = match;
    let hour = Number(hours);
    if (hour > 23 || (period && (hour < 1 || hour > 12))) return {};
    if (period) hour = (hour % 12) + (/^p|مس/u.test(period) ? 12 : 0);
    else if (hour > 0 && hour < 8 && hours.length === 1) hour += 12;
    const direction = /^(?:before|abel|2abel|قبل)/u.test(match[0])
      ? "before"
      : "after";
    return {
      after: "",
      before: "",
      [direction]: String(hour).padStart(2, "0") + ":" + minutes,
      ...(/\bstart after\b/u.test(text) ? { startsAtOrAfter: true } : {}),
    };
  }
  if (
    /\b(?:afternoon|later in the day|after lunch|ba3d el dohor)\b|بعد (?:الظهر|الغداء)/u.test(
      text,
    )
  )
    return { after: "12:00", before: "" };
  if (/\b(?:morning|saba7)\b|الصبح|صباحا/u.test(text))
    return { after: "", before: "12:00" };
  return {};
}
const sameDayWords =
  /\b(?:(?:the |that )?same (?:day|date)|nafs (?:el ?|l ?)?(?:yom|nhar)|(?:bi|b)nafs (?:el ?|l ?)?(?:yom|nhar)|(?:el ?|l ?)?(?:yom|nhar) nafs[ouh]+)\b|(?:ب?نفس)\s+(?:ال)?(?:يوم|نهار|تاريخ)(?!\p{L})|\b(?:that (?:very )?(?:same )?(?:day|afternoon|morning)|hal nhar|bhal nhar)\b|(?:اليوم|النهار|التاريخ)\s+نفسه(?!\p{L})|\b(?:the (?:date|day) of (?:(?:that|the|my|our) )?visit|that (?:visit )?date)\b|(?:نهار|يوم|تاريخ) (?:هالزياره|هالموعد)(?!\p{L})|(?:بهالنهار|بهداك (?:اليوم|النهار)|وقتها)(?!\p{L})|(?:ب?(?:تاريخ|موعد)|نهار) (?:الزياره|الموعد) نفسه(?!\p{L})|(?:هالزياره|الزياره) (?:نفسها|ذاتها)(?!\p{L})|(?:نفس|ذات) (?:هالزياره|الزياره)(?!\p{L})|\b(?:during|on) (?:that|the same) visit\b/gu;

export function sameDayReference(value) {
  const text = canon(value);
  return text.replace(sameDayWords, "") !== text;
}

export function resolveDay(value, date) {
  const text = scheduleText(canon(value).replace(sameDayWords, "")).replace(
    /\b(?:jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?(?=\s+\d|\s*$)/g,
    (short) =>
      ({
        jan: "january",
        feb: "february",
        mar: "march",
        apr: "april",
        jun: "june",
        jul: "july",
        aug: "august",
        sep: "september",
        oct: "october",
        nov: "november",
        dec: "december",
      })[short.replace(".", "")],
  );
  const weekdays = [
    /sunday|الاحد/,
    /monday|الاثنين/,
    /tuesday|الثلاثاء/,
    /wednesday|الاربعاء/,
    /thursday|الخميس/,
    /friday|الجمع[هة]/,
    /saturday|السبت/,
  ];
  const day = new Date(date + "T12:00:00Z");
  const weekdayText = text.split(/\binstead of\b|بدل(?:ا من)?/u)[0];
  const namedWeekdays = weekdays.flatMap((pattern, index) =>
    pattern.test(weekdayText) ? [index] : [],
  );
  if (namedWeekdays.length > 1) return { day: null, specified: true };
  const [namedWeekday = -1] = namedWeekdays;
  const months =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|تشرين الثاني|كانون الاول/iu;
  const month = months.exec(text);
  const numberedDay = /(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?$/u;
  const spokenOrdinals = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
    "twentieth",
    "twenty first",
    "twenty second",
    "twenty third",
    "twenty fourth",
    "twenty fifth",
    "twenty sixth",
    "twenty seventh",
    "twenty eighth",
    "twenty ninth",
    "thirtieth",
    "thirty first",
  ];
  const beforeMonth = month
    ? text
        .slice(0, month.index)
        .trimEnd()
        .replace(/\bday of$/u, "of")
    : "";
  const spokenDay =
    spokenOrdinals.findLastIndex(
      (word) =>
        beforeMonth.replace(/-/g, " ").endsWith(" " + word + " of") ||
        beforeMonth.replace(/-/g, " ") === word + " of",
    ) + 1;
  const dayAfterPhrase =
    /\b(?:the )?day after tomorrow\b|بعد\s+بكر[اه]|\bba3d (?:bokra|bukra|boukra)\b/gu;
  const withoutDayAfter = text.replace(dayAfterPhrase, " ");
  const relativeOffsets = [];
  if (/\b(?:today|l(?:yom|youm)|el ?yom)\b|اليوم|هاليوم/u.test(withoutDayAfter))
    relativeOffsets.push(0);
  if (
    /\btomorrow\b|بكر[اه]|(?<!\p{L})غدا?(?!\p{L})|\b(?:bokra|bukra|boukra)\b/u.test(
      withoutDayAfter,
    )
  )
    relativeOffsets.push(1);
  if (text !== withoutDayAfter) relativeOffsets.push(2);
  if (relativeOffsets.length > 1) return { day: null, specified: true };
  const [offset] = relativeOffsets;
  const relativeDate = offset === undefined ? null : addDays(date, offset);
  const explicitDates = [...new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/gu))];
  if (explicitDates.length > 1) return { day: null, specified: true };
  const [explicit] = explicitDates;
  const monthDay =
    month &&
    (numberedDay.exec(text.slice(0, month.index))?.[1] ??
      /^\s+(\d{1,2})(?:st|nd|rd|th)?\b/u.exec(
        text.slice(month.index + month[0].length),
      )?.[1] ??
      (spokenDay || null));
  const ordinal = /(?:اول الشهر|\bfirst of (?:the )?month\b)/u.test(text)
    ? 1
    : namedWeekday >= 0
      ? Number(
          /(?:^|\s)(\d{1,2})(?:st|nd|rd|th)(?=$|[\s,?.])/u.exec(text)?.[1],
        ) || null
      : null;
  if (explicit || monthDay || ordinal) {
    const candidate = explicit
      ? new Date(explicit + "T12:00:00Z")
      : new Date(day);
    if (!explicit) {
      const requestedDay = Number(monthDay || ordinal);
      const requestedMonth = monthDay
        ? [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
          ].indexOf(month[0])
        : -1;
      if (monthDay)
        candidate.setUTCMonth(
          requestedMonth >= 0
            ? requestedMonth
            : month[0] === "تشرين الثاني"
              ? 10
              : 11,
          requestedDay,
        );
      else {
        candidate.setUTCDate(requestedDay);
        if (candidate < day) {
          candidate.setUTCDate(1);
          candidate.setUTCMonth(candidate.getUTCMonth() + 1, requestedDay);
        }
      }
      if (candidate.getUTCDate() !== requestedDay)
        return { day: null, specified: true };
    }
    if (
      !Number.isFinite(+candidate) ||
      (explicit && candidate.toISOString().slice(0, 10) !== explicit) ||
      (relativeDate && candidate.toISOString().slice(0, 10) !== relativeDate) ||
      (namedWeekday >= 0 && candidate.getUTCDay() !== namedWeekday)
    )
      return { day: null, specified: true };
    return { day: candidate.toISOString().slice(0, 10), specified: true };
  }
  if (relativeDate) {
    day.setUTCDate(day.getUTCDate() + offset);
    if (namedWeekday >= 0 && day.getUTCDay() !== namedWeekday)
      return { day: null, specified: true };
  } else {
    const which = namedWeekday;
    if (which < 0)
      return {
        day: null,
        specified: Boolean(
          month ||
          /\b(?:weekday|\d{1,2}[/.-]\d{1,2})\b|نهار ال\p{L}+/u.test(text),
        ),
      };
    day.setUTCDate(day.getUTCDate() + ((which - day.getUTCDay() + 7) % 7));
  }
  return { day: day.toISOString().slice(0, 10), specified: true };
}

export const relativeDay = (value, date) => resolveDay(value, date).day;

// Resolve an explicit day first. The conversation only fills an omitted date.
export function resolveBeirutDate(value, today, context) {
  const explicit = resolveDay(value, today);
  if (explicit.specified) return explicit;
  if (!sameDayReference(value)) return explicit;
  return { day: previousShownDate(context), specified: true };
}

function previousShownDate(context) {
  // Older signed tokens did not have shownDate.
  if (!context) return null;
  if (Object.hasOwn(context, "shownDate"))
    return validDate(context.shownDate) ? context.shownDate : null;
  return validDate(context.serviceDay)
    ? context.serviceDay
    : onlyDate(context.choices?.map((choice) => choice[0]) ?? []);
}

export function validDate(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))
    return false;
  const instant = new Date(value + "T12:00:00Z");
  return (
    Number.isFinite(+instant) && instant.toISOString().slice(0, 10) === value
  );
}
export const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function onlyDate(days) {
  const unique = [...new Set(days.filter(validDate))];
  return unique.length === 1 ? unique[0] : null;
}

// A range searched is not necessarily what was displayed.
export function shownDateFor({ text, cards }, relativeDate) {
  const printed = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  const days = [
    ...printed,
    ...(cards ?? []).map((card) => card.date).filter(Boolean),
  ];
  return days.length ? onlyDate(days) : (relativeDate ?? null);
}

export const isCurrentWeek = (value) => /\bthis week\b/i.test(value);
export function sessionDateRange(
  intent,
  today,
  { day, currentWeek, timeOnlyContext },
) {
  const selectedDay = day ?? previousShownDate(timeOnlyContext);
  if (selectedDay) return { from: selectedDay, through: selectedDay };
  if (currentWeek) {
    const weekday = new Date(today + "T12:00:00Z").getUTCDay();
    return { from: today, through: addDays(today, (7 - weekday) % 7) };
  }
  const from = intent.from ?? today;
  if (!validDate(from)) return null;
  return { from, through: intent.through ?? addDays(from, 6) };
}

export function sessionDays({ from, through }, today) {
  if (
    !validDate(through) ||
    from < today ||
    through < from ||
    through > addDays(from, 6) ||
    through > addDays(today, 60)
  )
    return null;
  const days = [];
  for (let day = from; day <= through; day = addDays(day, 1)) days.push(day);
  return days;
}

export function resolveTurnDates(
  clinicMessage,
  hoursMessage,
  hours,
  combined,
  today,
  context,
) {
  const previous = previousShownDate(context);
  let clinic = combined
    ? resolveDay(clinicMessage, today)
    : resolveBeirutDate(clinicMessage, today, context);
  if (!hours) return { clinic, hourDays: null, conflict: false };
  const explicitHours = resolveDay(hoursMessage, today);
  if (combined && !clinic.specified && explicitHours.day)
    clinic = { ...clinic, day: explicitHours.day };
  const comparison = /\b(?:earlier|later)\b/i.test(hoursMessage)
    ? hoursMessage.match(
        /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      )
    : null;
  const severalDays =
    hours.weekend && !explicitHours.specified
      ? ["Saturday", "Sunday"]
      : comparison?.length === 2
        ? comparison
        : null;
  const inherited = combined ? clinic.day : previous;
  const hoursDate = resolveBeirutDate(hoursMessage, today, {
    shownDate: inherited,
  });
  const conflict =
    (combined && clinic.specified && !clinic.day) ||
    (!severalDays && hoursDate.specified && !hoursDate.day);
  const hourDays = severalDays
    ? [...new Set(severalDays.map((value) => relativeDay(value, today)))]
    : [hoursDate.day ?? (combined ? clinic.day : null) ?? today];
  return { clinic, hourDays, conflict };
}

export function selectSessionByTime(value, choices, pickedIndex) {
  const pickedTime = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/i.exec(value);
  const matches = pickedTime
    ? choices.filter(([, , , start]) => {
        const [, hour, minute = "00", period] = pickedTime;
        const hours = Number(hour);
        return (
          +start.slice(0, 2) ===
            (period ? (hours % 12) + (/pm/i.test(period) ? 12 : 0) : hours) &&
          start.slice(3) === minute
        );
      })
    : choices.filter((_, index) => index === pickedIndex);
  return matches.length === 1 ? matches[0] : null;
}
