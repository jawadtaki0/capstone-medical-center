import { specialtyDefinitions } from "../src/data/specialties.js";
import {
  canon,
  cancellationConcept,
  clinicalConcept,
  instructionConcept,
  requestedProfessional,
  privateResultRequest,
  unrelatedConcept,
  urgentConcept,
} from "./public-assistant-language.js";
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
  /\b(?:not|never)\s+(?:thinking|going|planning)|ما (?:عم فكر|بدي)|لا (?:افكر|اريد)|\b(?:ma|mesh|mish) (?:3am )?(?:badde|fakker|fekker|khay[ef]+[ef]?[ae]?)\b/iu;
const immediateDanger =
  /(?:افكر|عم (?:فكر|بفكر)|بدي|رح|خايف)\s*(?:اني\s*)?(?:(?:ائذي|اوذي|اذي|اضر|اجرح|اقتل)\s*(?:حالي|نفسي)|انهي حياتي)|\b(?:i might injure|i'?ll harm|i'?ll hurt) myself\b|\b(?:ma|mesh|mish)\s+(?:3am\s+)?(?:e2dar|2ader|2dar|bi2dar|b2dar)\s+(?:etnaffas|etnafas|atnaffas)\b|\bkhay[ef]+[ef]?[ae]?\s+(?:enne|enno|inni)\s+(?:2eze|2azi|2azzi|e2zi)\s+(?:nafse|nafsi|7ale|7ali)\b|\b(?:3am (?:fakker|fekker)|badde|ra7)\s+(?:enno\s+)?(?:e2ze|e2zi|2ze|2eze|2ezi|2a[zd]+[ei]|2tol)\s+(?:7ale|7ali|hale)\b/iu;
const directArabicDanger =
  /(?:ما عم (?:بقدر|اقدر|فيني) (?:اتنفس|اخد نفس)|نفسي عم ينقطع|نفسي عم يضيق|مش عم يوصلني هوا|ما عم يدخل هوا|(?:مش|ماني|مانا) قادر[ة]? (?:اخد نفس|اتنفس)|(?:صدري|قلبي) عم (?:يوجعني|يالم[ني]+)|^(?:لا (?:استطيع|اقدر) (?:التنفس|ان اتنفس)|ما (?:بقدر|فيني) (?:اتنفس|اخد نفس)|(?:اشعر|احس) ب(?:الم|ضغط) (?:في |ب)?صدري))/u;

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

export function emergencyDisclosure(value, { includeUncertain = false } = {}) {
  const text = normalize(value);
  const quotes =
    /"([^"]*)"|“([^”]*)”|«([^»]*)»|(?<!\p{L})'((?:[^']|(?<=\p{L})'(?=\p{L}))*)'(?!\p{L})/gu;
  const quoted = [...text.matchAll(quotes)];
  const educational =
    general.test(text) ||
    /^(?:if |suppose |hypothetically |اذا |لو )|\b(?:phrase|quotation|quote|example|translation|in (?:the|a) (?:story|movie|book))\b|^(?:ترجم|كيف نقول|ما معنى)/iu.test(
      text,
    );
  if (
    !educational &&
    quoted.length &&
    /(?: said | told me| يقول| قالت| قال لي)/iu.test(text) &&
    quoted.some((m) => {
      const clause = m[1] ?? m[2] ?? m[3] ?? m[4];
      return (
        (danger.test(clause) ||
          selfHarm.test(clause) ||
          immediateDanger.test(clause) ||
          urgentConcept(clause)) &&
        !negatedSelfHarm.test(clause) &&
        !negated.test(clause)
      );
    })
  )
    return true;
  return text
    .replace(quotes, "")
    .split(
      /[.!?؟؛;,،]|\bbut\b|\band\s+(?=(?:i|my|he|she|they)\b)|\bw\s+(?=3am\b)|لكن|بس /u,
    )
    .some((clause) => {
      const value = clause.trim();
      if (
        negated.test(value) ||
        /\b(?:no|without|den(?:y|ies)|not experiencing)\s+(?:any\s+)?(?:shortness of breath|breathing (?:trouble|difficulty)|trouble breathing)|\b(?:am|is|are|was|were) not (?:gasping|choking|fainting|seizing|suffocating|planning to harm)\b|(?:ما عندي|ليس لدي|لا اعاني من|ما في) (?:ضيق|صعوبه) (?:ب|في )?(?:ال)?(?:نفس|تنفس)/iu.test(
          canon(value),
        )
      )
        return false;
      if (
        negatedSelfHarm.test(value) &&
        /myself|نفسي|حالي|7ale|7ali|hale|nafse|nafsi/u.test(value)
      )
        return false;
      if (
        (selfHarm.test(value) ||
          immediateDanger.test(value) ||
          directArabicDanger.test(value) ||
          urgentConcept(value) ||
          (includeUncertain &&
            /\b(?:i|my)\b.{0,32}\b(?:can't|cannot|might not|not sure i can|don't know if i can)\s+(?:keep myself|stay|be) safe\b|مش (?:متاكد|متاكده) (?:فيني|بقدر) (?:ضل|ابقى) بامان/u.test(
              canon(value),
            ))) &&
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

export const cancellationRequest = (message) =>
  cancellationConcept(message) ||
  /\b(?:cancel|delete|remove)\b.{0,30}\b(?:booking|appointment|request)\b|(?:الغي?|تلغيلي|احذف|تشيل|شيل).{0,40}(?:موعد|حجز)/iu.test(
    normalize(message),
  );

export function localRoute(message) {
  const text = normalize(message);
  const clinicalText = text.replace(
    /(?:\b(?:no diagnosis|not (?:asking|looking) for (?:a )?diagnos\w*|don'?t (?:want|need) (?:a )?diagnos\w*)\b|(?:مش|ما)\s+(?:عم\s+)?(?:اطلب|طالب|بدي|اريد)\s+(?:اي\s+)?تشخيص)/giu,
    "",
  );
  if (emergencyDisclosure(text)) return "emergency";
  if (cancellationRequest(text) || privateResultRequest(text)) return "private";
  if (instructionConcept(text)) return "override";
  if (
    /\b(?:ignore|disregard|bypass)\s+(?:(?:the|all|your)\s+)?(?:cedar |clinic |safety )?(?:rules|instructions|restrictions)\b/u.test(
      text,
    )
  )
    return "override";
  if (
    /\b(?:i(?:'ve| have) had|i have|my)\b.{0,40}\b(?:headache|dizziness|fever|nausea|stomachache)\b.{0,55}\b(?:what is it|what (?:could|might) it be|what (?:could|might) be causing it)\b/u.test(
      text,
    )
  )
    return "clinical";
  if (
    /ignore (?:all |your |previous )*(?:rules|instructions)|override|jailbreak|system prompt|(?:private|hidden|internal) (?:operating |setup )?(?:instructions|rules)|(?:translate|repeat|show|reveal|paste|print) (?:all )?your (?:internal )?(?:instructions|rules)|(?:show|print|repeat|quote|reveal)\b.{0,30}\binstructions\b.{0,40}\b(?:you (?:were given|received)|before (?:this |the )?chat)|\b(?:reveal|share|show|print|give me)\b.{0,25}\b(?:private|hidden|internal) rules\b|reveal.*prompt|تجاهل.*(?:تعليمات|قواعد)|(?:اكشف|اظهر|انسخ).*(?:التعليمات|القواعد)|نسيت القواعد|(?:warjine|farjine|ekteble).*(?:ta3limet|ta3limat|system prompt)/i.test(
      text,
    )
  )
    return "override";
  if (
    /\b(?:my|i got|i have)\b.{0,50}\b(?:came back|tested|result|levels?)\b.{0,75}\b(?:what condition|what (?:do i have|is wrong with me)|what disease|what does it mean)\b|طلعت نتيجتي.*(?:شو عندي|شو يعني|ما المرض)|natijte.*(?:shu 3ande|shu ya3ne)/iu.test(
      text,
    ) ||
    /\b(?:what (?:does|do)|interpret|explain)\b.{0,40}\b(?:my\s+)?(?:lab\s+)?results?\b.{0,20}\bmean\b|\b(?:interpret|explain) my (?:lab )?(?:results?|report)\b|شو (?:هي )?الجرع[هة]|(?:كم|اي) جرع[هة].{0,30}(?:اخد|اتناول)|شو يعني نتيجتي|ما معنى نتيجتي|نتيج[هة].{0,45}(?:عندي|تبعي).{0,45}(?:شو يعني|هل عندي|عندي مرض)|\b(?:natije|ta7lil)\b.{0,35}\b(?:3ande|taba3e)\b.{0,45}\b(?:shu ya3ne|3ande marad)\b/iu.test(
      text,
    )
  )
    return "clinical";
  if (clinicalConcept(clinicalText)) return "clinical";
  if (
    /\b(?:patient|visitor) names\b|(?:اسماء|اسامي) (?:جميع )?(?:المرضى|المراجعين)|\b(?:asame|asemi)\s+(?:el |l )?(?:marda|mar[dt]a)\b/iu.test(
      text,
    ) ||
    /[\w.+-]+@[\w.-]+|\b(?:WR|LAB|P)-[\da-f-]{6,}|(?:\+?\d[ ().-]*){7,}|\b(?:my|personal)\b.{0,24}\b(?:appointments?|bookings?|reports?|results?|records?|password|account|requests?)\b|\b(?:my id number|patient records?|someone else.?s (?:records?|cedar account|visit history)|(?:their|another patient.?s) (?:lab report|test results?|visit history|medical records?|account)|\b(?:look up|pull up|retrieve|show)\b.{0,65}\b(?:lab report|test results?|visit history)\b.{0,35}\b(?:their|someone else.?s|coworker.?s)\b|reset (?:my )?password|booking status|report status)\b|\b(?:list|show|name)\b.{0,30}\bpatients\b|تلغيلي.{0,20}(?:حجز|موعد)|نتيجتي|موعدي|حجزي|تقريري|سجلي|حسابي|طلبي|كلمة السر|natijte|maw3ade|7sebe/iu.test(
      text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""),
    )
  )
    return "private";
  if (
    (/\bshould i do\b/u.test(clinicalText) &&
      !serviceLogistics(clinicalText)) ||
    /\b(?:diagnos\w*|prescri\w*|dosage|symptom\w*|treatment|what dose|should i (?:take|stop|get|fast)|interpret\w*|what causes|what is (?:chest pain|a seizure)|can chest pain)\b|تشخيص|جرعة|اعراض|هل اتناول|هل اصوم|علاج|ما معنى الم الصدر|شو يعني وجع|adde.*(?:dose|dawa)|shu.*dawa/iu.test(
      clinicalText,
    )
  )
    return "clinical";
  if (
    unrelatedConcept(text) ||
    /\b(?:weather|forecast|football (?:score|match)|bitcoin price|graphics cards?|gaming (?:pc|computer)|packing list|camping trip|birthday party|playlist for (?:a |my )?party|(?:bicycle|bike) (?:tire|tyre)|flat (?:bicycle|bike) (?:tire|tyre)|write (?:me )?a poem|recipe)\b|\b(?:recommend|find|suggest|where)\b.{0,50}\b(?:restaurants?|cafes?)\b|الطقس|حالة الجو|كيف الجو|جو بكرا|kif.*ta2es/iu.test(
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
  if (/\bdentist\b|اسنان/u.test(text)) matches.add("Dentistry");
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
