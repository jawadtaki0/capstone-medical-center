import { specialtyDefinitions } from "../src/data/specialties.js";
import {
  canon,
  cancellationConcept,
  clinicalConcept,
  correctTypos,
  instructionConcept,
  requestedProfessional,
  unrelatedConcept,
  urgentConcept,
} from "./public-assistant-language.js";

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
  /\b(?:not|never)\s+(?:thinking|going|planning)|ما (?:عم فكر|بدي)|لا (?:افكر|اريد)|\b(?:ma|mesh|mish) (?:3am|badde|fakker|khay[ef]+[ef]?[ae]?)\b/iu;
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

export function emergencyDisclosure(value) {
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
    .split(/[.!?؟؛;,،]|\bbut\b|\band\s+(?=(?:i|my|he|she|they)\b)|لكن|بس /u)
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
          urgentConcept(value)) &&
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
  if (emergencyDisclosure(text)) return "emergency";
  if (cancellationRequest(text)) return "private";
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
    clinicalConcept(text) ||
    (/\bshould i do\b/u.test(text) && !serviceLogistics(text)) ||
    /\b(?:diagnos\w*|prescri\w*|dosage|symptom\w*|treatment|what dose|should i (?:take|stop|get|fast)|interpret\w*|what causes|what is (?:chest pain|a seizure)|can chest pain)\b|تشخيص|جرعة|اعراض|هل اتناول|هل اصوم|علاج|ما معنى الم الصدر|شو يعني وجع|adde.*(?:dose|dawa)|shu.*dawa/iu.test(
      text,
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
const scheduleText = (value) =>
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
const sameDayWords =
  /\b(?:(?:the |that )?same (?:day|date)|nafs (?:el ?|l ?)?(?:yom|nhar)|(?:bi|b)nafs (?:el ?|l ?)?(?:yom|nhar)|(?:el ?|l ?)?(?:yom|nhar) nafs[ouh]+)\b|(?:ب?نفس)\s+(?:ال)?(?:يوم|نهار|تاريخ)(?!\p{L})|(?:اليوم|النهار|التاريخ)\s+نفسه(?!\p{L})/gu;

export function sameDayReference(value) {
  const text = canon(value);
  return text.replace(sameDayWords, "") !== text;
}

export function resolveDay(value, date) {
  const text = scheduleText(canon(value).replace(sameDayWords, ""));
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
  const namedWeekday = weekdays.findIndex((pattern) => pattern.test(text));
  const months =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|تشرين الثاني|كانون الاول/iu;
  const month = months.exec(text);
  const numberedDay = /(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?\s+$/u;
  const explicit = /\b\d{4}-\d{2}-\d{2}\b/u.exec(text)?.[0];
  const monthDay =
    month &&
    (numberedDay.exec(text.slice(0, month.index))?.[1] ??
      /^\s+(\d{1,2})(?:st|nd|rd|th)?\b/u.exec(
        text.slice(month.index + month[0].length),
      )?.[1]);
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
      (namedWeekday >= 0 && candidate.getUTCDay() !== namedWeekday)
    )
      return { day: null, specified: true };
    return { day: candidate.toISOString().slice(0, 10), specified: true };
  }
  const today = /\b(?:today|l(?:yom|youm)|el ?yom)\b|اليوم|هاليوم/u.test(text);
  const tomorrow =
    /\btomorrow\b|بكر[اه]|(?<!\p{L})غدا?(?!\p{L})|\b(?:bokra|bukra|boukra)\b/u.test(
      text,
    );
  if (today && tomorrow) return { day: null, specified: true };
  if (today || tomorrow) {
    day.setUTCDate(day.getUTCDate() + Number(tomorrow));
    if (namedWeekday >= 0 && day.getUTCDay() !== namedWeekday)
      return { day: null, specified: true };
  } else {
    const which = weekdays.findIndex((pattern) => pattern.test(text));
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

export function scheduleRequest(message, today) {
  return {
    ...resolveDay(message, today),
    specialty: scheduleSpecialty(message),
    time: scheduleTime(message),
    clinician:
      (!scheduleSpecialty(message) && requestedProfessional(message)) ||
      /\b(?:dr\.?|doctor)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}?)\s+(?:available|listed|in|for|on (?:(?:the )?published(?: [\p{L}]+)?|the|[\p{L}'’-]+(?:’s|'s)? published) schedule)\b/iu.exec(
        message,
      )?.[1] ||
      /\b(?:surname|last name)\s+([\p{L}][\p{L}'’-]*)/iu.exec(message)?.[1],
    availability: availabilityQuestion(message),
  };
}
