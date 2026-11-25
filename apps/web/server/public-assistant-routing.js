import { specialtyDefinitions } from "../src/data/specialties.js";

const normalize = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064b-\u065fـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/[’‘]/g, "'");

const danger =
  /\b(?:can'?t breathe|cannot breathe|not breathing|struggling to breathe|chest pain|crushing chest pressure|bleeding heavily|heavy bleeding|won'?t stop bleeding|unconscious|passed out|having a seizure|overdosed|took too many pills|kill myself|end my life|hurt myself|suicidal|face droop\w*)\b|مش قادر[ة]? اتنفس|ما عم يقدر يتنفس|لا استطيع التنفس|لا يتنفس|الم (?:في )?الصدر|وجع (?:ب)?صدري|نزيف (?:حاد|شديد)|فاقد[ة]? الوعي|اغمي عليه|عم اختنق|بدي انتحر|بدي اقتل حالي|جرعة زائدة|ma (?:3am|am) (?:bi2dar|2ader|2dar|yi2dar) (?:etnaffas|etnafas|yetnaffas)|mish 2ader etnafas|waja3 (?:b)?sadri|وجع بصدر|badde enta7er/iu;
const general =
  /^(?:what (?:is|are|does|causes)|can (?:a|chest|heavy)|why (?:does|do)|in (?:a|an) (?:example|story)|for example|define|ما (?:هو|هي|معنى|اسباب)|ماذا يعني|مثال|شو يعني)\b|^(?:ما هو|ما هي|ما معنى|ما اسباب|ماذا يعني|مثال|شو يعني)/iu;
const negated =
  /^(?:[^,;]{0,60}\b(?:no|not|never|don'?t have|doesn'?t have|without|denies)\s+(?:any\s+)?(?:chest pain|heavy bleeding|bleeding heavily|unconscious|suicidal)\b)|^(?:[^،;]{0,60}(?:ما عندي|ليس لدي|لا اعاني من|ما في|ma 3ande)\s+(?:الم|وجع|نزيف|waja3))/iu;
const reported =
  /\b(?:i|we|he|she|they) (?:have|has|am|is|are|just)|\b(?:my|our) \w+ (?:has|is)|\bi (?:want|plan)|right now|\bi took\b|عندي|عم |بدي|والدي|والدتي|بنتي|ابني|3am|3ande|badde/iu;
const selfHarm =
  /\b(?:i am|i'm|i) (?:thinking (?:about|of)|want to|might|going to|plan(?:ning)? to) (?:(?:hurt(?:ing)?|harm(?:ing)?|kill(?:ing)?) myself|suicide|ending my life)\b|(?:افكر|اريد|انوي|بدي|رح|عم فكر)\s*(?:(?:ب|في |ان )?(?:ايذاء|اوذي|ااذي|اذي|اقتل) نفسي|انتحر|اقتل حالي)|\b(?:3am (?:fakker|fekker)|badde|ra7) (?:2eze|2azi|azi|eze|2tol|2u2tol|2ezi|e2zi) (?:7ale|7ali|hale)\b/iu;
const negatedSelfHarm =
  /\b(?:not|never)\s+(?:thinking|going|planning)|ما (?:عم فكر|بدي)|لا (?:افكر|اريد)|\b(?:ma|mesh|mish) (?:3am|badde|fakker)\b/iu;
const immediateDanger =
  /(?:افكر|عم (?:فكر|بفكر)|بدي|رح|خايف)\s*(?:اني\s*)?(?:(?:ائذي|اوذي|اذي|اضر|اجرح|اقتل)\s*(?:حالي|نفسي)|انهي حياتي)|\b(?:i might injure|i'?ll harm|i'?ll hurt) myself\b|\b(?:ma|mesh|mish)\s+(?:3am\s+)?(?:e2dar|2ader|2dar|bi2dar|b2dar)\s+(?:etnaffas|etnafas|atnaffas)\b|\b(?:3am (?:fakker|fekker)|badde|ra7)\s+(?:enno\s+)?(?:e2ze|e2zi|2ezi|2azi|2tol)\s+(?:7ale|7ali|hale)\b/iu;

export const rulesCopy = {
  en: {
    emergency:
      "This may be an emergency. Call emergency services now. In Lebanon, call the Lebanese Red Cross ambulance at 140. Do not wait for a chat reply or a Cedar appointment.",
    override:
      "I can’t share private instructions or change those rules. I can help with Cedar’s clinics, lab tests, Audiometry, and appointment requests.",
    private:
      "This chat can’t access private information. Sign in to My account for your booking requests or Lab results, or contact Reception for help.",
    clinical:
      "I can’t diagnose, recommend treatment or doses, or interpret symptoms or personal results. Please speak with a clinician or contact Reception.",
    identity: "I’m Ask Cedar, Cedar Medical Center’s automated assistant.",
    greeting: "Hello! What would you like to know about Cedar?",
    thanks: "You’re welcome!",
    clarify:
      "Which clinic, professional, or session would you like me to check?",
  },
  ar: {
    emergency:
      "قد تكون هذه حالة طارئة. اتصل بخدمات الطوارئ فورًا. في لبنان، اتصل بإسعاف الصليب الأحمر اللبناني على الرقم 140. لا تنتظر رد الدردشة أو موعدًا في سيدر.",
    override:
      "لا يمكنني مشاركة التعليمات الخاصة أو تغيير هذه القواعد. يمكنني مساعدتك في عيادات سيدر وفحوصات المختبر والسمع وطلبات المواعيد.",
    private:
      "لا تستطيع هذه الدردشة الوصول إلى معلومات خاصة. سجّل الدخول إلى حسابي لعرض طلبات المواعيد أو نتائج المختبر، أو تواصل مع الاستقبال.",
    clinical:
      "لا يمكنني التشخيص أو اقتراح العلاج أو الجرعات أو تفسير الأعراض والنتائج الشخصية. تحدث مع مختص صحي أو تواصل مع الاستقبال.",
    identity: "أنا اسأل سيدر، المساعد الآلي لمركز سيدر الطبي.",
    greeting: "مرحبًا! ماذا تود أن تعرف عن سيدر؟",
    thanks: "على الرحب والسعة!",
    clarify: "أي عيادة أو اختصاصي أو جلسة تريد التحقق منها؟",
  },
};

export function emergencyDisclosure(value) {
  const text = normalize(value);
  const quoted = [...text.matchAll(/"([^"]*)"|“([^”]*)”|«([^»]*)»/g)];
  if (
    quoted.length &&
    /(?: said | told me| يقول| قالت| قال لي)/iu.test(text) &&
    quoted.some((m) => {
      const clause = m[1] ?? m[2] ?? m[3];
      return (
        (danger.test(clause) ||
          selfHarm.test(clause) ||
          immediateDanger.test(clause)) &&
        !negatedSelfHarm.test(clause) &&
        !negated.test(clause)
      );
    })
  )
    return true;
  return text
    .replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, "")
    .split(/[.!?؟؛;,،]|\bbut\b|\band\s+(?=(?:i|my|he|she|they)\b)|لكن|بس /u)
    .some((clause) => {
      const value = clause.trim();
      if (
        negatedSelfHarm.test(value) &&
        /myself|نفسي|حالي|7ale|7ali|hale/u.test(value)
      )
        return false;
      if (
        (selfHarm.test(value) || immediateDanger.test(value)) &&
        !general.test(value) &&
        !/^(?:if |suppose |hypothetically |لو |اذا )/u.test(value)
      )
        return true;
      if (
        !danger.test(value) ||
        negated.test(value) ||
        general.test(value) ||
        /^(?:if |suppose |hypothetically |لو |اذا )/u.test(value)
      )
        return false;
      return (
        reported.test(value) ||
        /^(?:(?:i )?can'?t breathe|(?:i )?cannot breathe|not breathing|heavy bleeding|chest pain|unconscious|ما عم|مش قادر|نزيف شديد|وجع|الم الصدر)/u.test(
          value,
        )
      );
    });
}

export function serviceLogistics(value) {
  const text = normalize(value);
  return (
    /\b(?:blood test|lab(?:oratory)? test|lab visit)\b/u.test(text) &&
    /\b(?:what should i do first|how (?:can|do) i (?:get|request|arrange)|book.*online)\b/u.test(
      text,
    ) &&
    !/\b(?:treatment|dose|diagnos\w*|symptom\w*|medicine|medication|drug)\b/u.test(
      text,
    )
  );
}

export function localRoute(message) {
  const text = normalize(message);
  if (emergencyDisclosure(text)) return "emergency";
  if (
    /\b(?:i(?:'ve| have) had|i have|my)\b.{0,40}\b(?:headache|dizziness|fever|nausea|stomachache)\b.{0,55}\b(?:what is it|what (?:could|might) it be|what (?:could|might) be causing it)\b/u.test(
      text,
    )
  )
    return "clinical";
  if (
    /ignore (?:all |your |previous )*(?:rules|instructions)|override|jailbreak|system prompt|(?:private|hidden|internal) instructions|(?:translate|repeat|show|reveal|paste|print) (?:all )?your (?:internal )?(?:instructions|rules)|reveal.*prompt|تجاهل.*(?:تعليمات|قواعد)|(?:اكشف|اظهر|انسخ).*(?:التعليمات|القواعد)|نسيت القواعد|(?:warjine|farjine|ekteble).*(?:ta3limet|ta3limat|system prompt)/i.test(
      text,
    )
  )
    return "override";
  if (
    /\b(?:my|i got|i have)\b.{0,50}\b(?:came back|tested|result|levels?)\b.{0,75}\b(?:what condition|what (?:do i have|is wrong with me)|what disease|what does it mean)\b|طلعت نتيجتي.*(?:شو عندي|شو يعني|ما المرض)|natijte.*(?:shu 3ande|shu ya3ne)/iu.test(
      text,
    ) ||
    /\b(?:what (?:does|do)|interpret|explain)\b.{0,40}\b(?:my\s+)?(?:lab\s+)?results?\b.{0,20}\bmean\b|\b(?:interpret|explain) my (?:lab )?(?:results?|report)\b|شو يعني نتيجتي|ما معنى نتيجتي/iu.test(
      text,
    )
  )
    return "clinical";
  if (
    /\b(?:patient|visitor) names\b|(?:اسماء|اسامي) (?:جميع )?(?:المرضى|المراجعين)|\b(?:asame|asemi)\s+(?:el |l )?(?:marda|mar[dt]a)\b/iu.test(
      text,
    ) ||
    /[\w.+-]+@[\w.-]+|\b(?:WR|LAB|P)-[\da-f-]{6,}|(?:\+?\d[ ().-]*){7,}|\b(?:my|personal)\b.{0,24}\b(?:appointments?|bookings?|reports?|results?|records?|password|account|requests?)\b|\b(?:my id number|patient records?|someone else.?s records?|reset (?:my )?password|booking status|report status)\b|\b(?:list|show|name)\b.{0,30}\bpatients\b|نتيجتي|موعدي|تقريري|سجلي|حسابي|طلبي|كلمة السر|natijte|maw3ade|7sebe/iu.test(
      text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""),
    )
  )
    return "private";
  if (
    (/\bshould i do\b/u.test(text) && !serviceLogistics(text)) ||
    /\b(?:diagnos\w*|prescri\w*|dosage|symptom\w*|treatment|what dose|should i (?:take|stop|get|fast)|interpret\w*|what causes|what is (?:chest pain|a seizure)|can chest pain)\b|تشخيص|جرعة|اعراض|هل اتناول|هل اصوم|علاج|ما معنى الم الصدر|شو يعني وجع|adde.*(?:dose|dawa)|shu.*dawa/iu.test(
      text,
    )
  )
    return "clinical";
  if (
    /\b(?:weather|forecast|football (?:score|match)|bitcoin price|write (?:me )?a poem|recipe)\b|الطقس|حالة الجو|كيف الجو|جو بكرا|kif.*ta2es/iu.test(
      text,
    )
  )
    return "unrelated";
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
const scheduleText = (value) =>
  normalize(value)
    .replace(/\b(?:tomorow|tomoorow|tommorow|tommorrow|tmrw)\b/g, "tomorrow")
    .replace(/\bdr\.?\b/g, "doctor")
    .replace(/\bspecalist\b/g, "specialist")
    .replace(/\bcardiolgy\b/g, "cardiology")
    .replace(/\bsesions\b/g, "sessions")
    .replace(/\bthursdy\b/g, "thursday")
    .replace(/\bgastroentrology\b/g, "gastroenterology")
    .replace(/\b(?:jom3a|jem3a|j[ou]m3a)\b/g, "friday")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632));

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
              normalize(alias)
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
  if (/\bdentist\b|اسنان/u.test(text)) matches.add("Dentistry");
  const colloquial = {
    ophthalmology:
      /\beye (?:doctor|specialist|surgeon)\b|طبيب (?:عيون|العيون)|دكتور عيون/u,
    urology: /مسالك بولي[هة]|\burinary specialist\b/u,
    dietitian: /اختصاصي[هة]? تغذي[هة]|اخصائي[هة]? تغذي[هة]|\bnutritionist\b/u,
    ent: /\bear (?:doctor|specialist)\b|(?:انف|اذن|انف واذن) وحنجر[هة]|\b7akim wedan\b/u,
    surgery: /\bgeneral surgeon\b|جراح عام/u,
  };
  for (const { id, label } of specialtyDefinitions)
    if (colloquial[id]?.test(text)) matches.add(label);
  return matches.size === 1 ? [...matches][0] : "";
}

export function scheduleTime(value) {
  const text = scheduleText(value);
  if (
    /\b(?:drop|remove|clear|without)\b.{0,22}\b(?:morning|afternoon|time)\b|\bany time\b/u.test(
      text,
    )
  )
    return { after: "", before: "" };
  const match =
    /(?:\b(after|before|ba3d|abel|2abel)\s+|(?:بعد|قبل)\s+)(?:(?:الساعة|l|el)\s+|ال\s*)?(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|صباحا?|مساء?)?(?![\d:])/u.exec(
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
export const availabilityQuestion = (value) => {
  const message = scheduleText(value);
  return (
    (scheduleSpecialty(message) ||
      /\b(?:sessions?|slots?|appointments?|doctors?|doktor|daktor|specialist|cardiology|dermatology|clinic)\b|جلس[هةات]|موعد|مواعيد|عياد[هة]|طبيب|دكتور|قلب|جلدي|maw3ad|doctor|7ajz/iu.test(
        message,
      )) &&
    (Object.keys(scheduleTime(message)).length > 0 ||
      /\b(?:available|availability|open|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|when|can i see|could i see|find|show|are there|any|next|book)\b|اليوم|بكرا|غد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|السبت|الاحد|متى|هل يوجد|في مواعيد|متاح|f[iy]|bukra|bokra|emta|\d{4}-\d{2}-\d{2}/iu.test(
        message,
      ))
  );
};
export const refinementQuestion = (value) =>
  /^(?:(?:actually|instead|and|what about|how about)[,\s]+)?(?:only|after|before|any later|afternoon|morning|tomorrow|today|(?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|later|بس|فقط|بعد|قبل|الصبح|بكرا|غدا|هل يوجد وقت|وقتا|ba3d|bas|bokra|bukra)/iu.test(
    scheduleText(value),
  );
export const specialtyCorrection = (value) =>
  /^(?:actually|instead|what about|how about)[,\s]+|\binstead[?.!]*$/u.test(
    scheduleText(value),
  );
export const genericArabiziAvailability = (value) =>
  /^(?:(?:f[iy]|doctor|doktor|daktor|bokra|bukra|emta|maw3ad|pls)\b\s*)+[?.!؟]*$/u.test(
    scheduleText(value),
  );
export function relativeDay(value, date) {
  const text = scheduleText(value);
  const weekdays = [
    /sunday|الاحد/,
    /monday|الاثنين/,
    /tuesday|الثلاثاء/,
    /wednesday|الاربعاء/,
    /thursday|الخميس/,
    /friday|الجمعة/,
    /saturday|السبت/,
  ];
  const day = new Date(date + "T12:00:00Z");
  if (/\btoday\b|اليوم|lyom/.test(text)) return date;
  if (
    /\btomorrow\b|بكرا|(?<!\p{L})غدا?(?!\p{L})|\b(?:bokra|bukra)\b/u.test(text)
  )
    day.setUTCDate(day.getUTCDate() + 1);
  else {
    const which = weekdays.findIndex((pattern) => pattern.test(text));
    if (which < 0) return null;
    day.setUTCDate(day.getUTCDate() + ((which - day.getUTCDay() + 7) % 7));
  }
  return day.toISOString().slice(0, 10);
}
