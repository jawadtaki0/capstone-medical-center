import {
  canon,
  cancellationConcept,
  clinicalConcept,
  instructionConcept,
  privateResultRequest,
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

const quotes =
  /"([^"]*)"|“([^”]*)”|«([^»]*)»|(?<!\p{L})'((?:[^']|(?<=\p{L})'(?=\p{L}))*)'(?!\p{L})/gu;

const danger =
  /\b(?:can'?t breathe|cannot breathe|not breathing|struggling to breathe|chest pain|crushing chest pressure|bleeding heavily|heavy bleeding|won'?t stop bleeding|unconscious|passed out|having a seizure|overdosed|took too many pills|kill myself|end my life|hurt myself|suicidal|face droop\w*)\b|مش قادر[ة]? اتنفس|ما عم يقدر يتنفس|لا استطيع التنفس|لا يتنفس|الم (?:في )?الصدر|وجع (?:ب)?صدري|نزيف (?:حاد|شديد)|فاقد[ة]? الوعي|اغمي عليه|مغمى عليه[ا]?|ما عم تستفيق|عم اختنق|بدي انتحر|بدي اقتل حالي|جرعة زائدة|ma (?:3am|am) (?:bi2dar|2ader|2dar|yi2dar) (?:etnaffas|etnafas|yetnaffas)|mish 2ader etnafas|waja3 (?:b)?sadri|وجع بصدر|badde enta7er/iu;
const general =
  /^(?:what (?:is|are|does|causes)|can (?:a|chest|heavy)|why (?:does|do)|in (?:a|an) (?:example|story)|for example|define|ما (?:هو|هي|معنى|اسباب)|ماذا يعني|مثال|شو يعني)\b|^(?:ما هو|ما هي|ما معنى|ما اسباب|ماذا يعني|مثال|شو يعني)/iu;
const negated =
  /^(?:[^,;]{0,60}\b(?:no|not|never|don'?t have|doesn'?t have|without|denies)\s+(?:any\s+)?(?:chest pain|heavy bleeding|bleeding heavily|unconscious|suicidal)\b)|^(?:[^،;]{0,60}(?:ما عندي|ليس لدي|لا اعاني من|ما في|ma 3ande)\s+(?:الم|وجع|نزيف|waja3))/iu;
const reported =
  /\b(?:i|we|he|she|they) (?:have|has|am|is|are|just)|\b(?:my|our) \w+ (?:has|is)|\bi (?:want|plan)|right now|\bi took\b|عندي|عم |بدي|مرتي|جوزي|والدي|والدتي|بنتي|ابني|3am|3ande|badde/iu;
const selfHarm =
  /\b(?:i am|i'm|i) (?:thinking (?:about|of)|want to|might|going to|plan(?:ning)? to) (?:(?:hurt(?:ing)?|harm(?:ing)?|kill(?:ing)?) myself|suicide|ending my life)\b|(?:افكر|اريد|انوي|بدي|رح|عم فكر)\s*(?:(?:ب|في |ان )?(?:ايذاء|اوذي|ااذي|اذي|اقتل) نفسي|انتحر|اقتل حالي)|\b(?:3am (?:fakker|fekker)|badde|ra7) (?:2eze|2azi|azi|eze|2tol|2u2tol|2ezi|e2zi) (?:7ale|7ali|hale)\b/iu;
const negatedSelfHarm =
  /\b(?:not|never)\s+(?:thinking|going|planning)|ما (?:عم فكر|بدي)|لا (?:افكر|اريد)|\b(?:ma|mesh|mish) (?:3am )?(?:badde|fakker|fekker|khay[ef]+[ef]?[ae]?)\b/iu;
const immediateDanger =
  /\b(?:khaye?f|khayfe)\s+(?:men|min)\s+(?:7al[ei]|nafs[ei])\b|(?:افكر|عم (?:فكر|بفكر)|بدي|رح|خايف)\s*(?:اني\s*)?(?:(?:ائذي|اوذي|اذي|اضر|اجرح|اقتل)\s*(?:حالي|نفسي)|انهي حياتي)|\b(?:i might injure|i'?ll harm|i'?ll hurt) myself\b|\b(?:ma|mesh|mish)\s+(?:3am\s+)?(?:e2dar|2ader|2dar|bi2dar|b2dar)\s+(?:etnaffas|etnafas|atnaffas)\b|\bkhay[ef]+[ef]?[ae]?\s+(?:enne|enno|inni)\s+(?:2eze|2azi|2azzi|e2zi)\s+(?:nafse|nafsi|7ale|7ali)\b|\b(?:3am (?:fakker|fekker)|badde|ra7)\s+(?:enno\s+)?(?:e2ze|e2zi|2ze|2eze|2ezi|2a[zd]+[ei]|2tol)\s+(?:7ale|7ali|hale)\b/iu;
const directArabicDanger =
  /(?:ما عم (?:بقدر|اقدر|فيني) (?:اتنفس|اخد نفس)|نفسي عم ينقطع|نفسي عم يضيق|مش عم يوصلني هوا|ما عم يدخل هوا|(?:مش|ماني|مانا) قادر[ة]? (?:اخد نفس|اتنفس)|(?:صدري|قلبي) عم (?:يوجعني|يالم[ني]+)|^(?:لا (?:استطيع|اقدر) (?:التنفس|ان اتنفس)|ما (?:بقدر|فيني) (?:اتنفس|اخد نفس)|(?:اشعر|احس) ب(?:الم|ضغط) (?:في |ب)?صدري))/u;

const guidedTopics = new Map([
  ["urgent", { kind: "emergency", copyKey: "emergency" }],
  [
    "private",
    { kind: "private", copyKey: "private", page: "/account#lab-results" },
  ],
  ["cancel", { kind: "private", copyKey: "cancel", page: "/account" }],
  ["clinical", { kind: "clinical", copyKey: "clinical" }],
]);

export const guidedTopic = (value) => guidedTopics.get(value);

export const rulesCopy = {
  en: {
    cancel:
      "Chat cannot cancel or reschedule your booking. Open My account to review your booking or contact Reception for help.",
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
    cancel:
      "لا يمكن إلغاء موعدك أو تغيير وقته من الدردشة. افتح حسابي لمراجعة موعدك أو تواصل مع الاستقبال للمساعدة.",
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
        /^(?:(?:i )?can'?t breathe|(?:i )?cannot breathe|not breathing|heavy bleeding|chest pain|unconscious|ما عم|مش قادر|نزيف شديد|وجع|الم الصدر|مغمى عليه[ا]?|ما عم تستفيق)/u.test(
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

const cancellationRequest = (message) =>
  cancellationConcept(message) ||
  bookingChange.test(canon(message)) ||
  /\b(?:cancel|delete|remove)\b.{0,30}\b(?:booking|appointment|request)\b|(?:الغي?|تلغيلي|احذف|تشيل|شيل).{0,40}(?:موعد|حجز)/iu.test(
    normalize(message),
  );

const bookingChange =
  /\b(?:reschedul\w*|rebook\w*|chang(?:e|ing)|mov(?:e|ing))\b.{0,48}\b(?:booking|appointment|reservation)\b|(?:غير|تغير|تغيير|تبديل|بدل|اجل|تاجيل|تاجل).{0,28}(?:موعد|حجز)|\b(?:teghyir\w*|tghay\w*|ghay\w*|baddel\w*|2ajjel\w*)\b.{0,38}\b(?:maw3[ae]d\w*|7aj[ez]+\w*)\b/iu;

const negatedRequest =
  /^(?:(?:i(?:'m| am)?\s+)?(?:(?:am\s+)?not\s+(?:asking|looking|requesting)|(?:do not|don't|did not|didn't)\s+(?:want|need|ask)|no\s+(?:cancellation|rescheduling|diagnosis|medical advice)\b)|(?:ma|mish|mesh)\s+(?:3am\s+)?(?:badde|baddi|bade|b?otlob|b?es2al))\b/iu;
const arabicNegatedRequest =
  /^(?:ما|مش|ماني)\s+(?:عم\s+)?(?:(?:ب|ا)?طلب|طالب|اسال|بسال|بدي|اريد)(?!\p{L})/u;

// Emergency disclosures use a separate guard since quoted speech can report a current emergency.
function activeRequest(text) {
  return text
    .replace(quotes, " ")
    .split(/(?<=[.!?؟])\s+|[,؛;،]|\bbut\b|\sبس\s|لكن/u)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        !negatedRequest.test(clause) && !arabicNegatedRequest.test(clause),
    )
    .join(" ");
}

const clinicalInterpretation = (text) =>
  /\b(?:i(?:'ve| have) had|i have|my)\b.{0,40}\b(?:headache|dizziness|fever|nausea|stomachache)\b.{0,55}\b(?:what is it|what (?:could|might) it be|what (?:could|might) be causing it)\b/u.test(
    text,
  ) ||
  /\b(?:my|i got|i have)\b.{0,50}\b(?:came back|tested|result|levels?)\b.{0,75}\b(?:what condition|what (?:do i have|is wrong with me)|what disease|what does it mean)\b|طلعت نتيجتي.*(?:شو عندي|شو يعني|ما المرض)|natijte.*(?:shu 3ande|shu ya3ne)/iu.test(
    text,
  ) ||
  /\b(?:what (?:does|do)|interpret|explain)\b.{0,40}\b(?:my\s+)?(?:lab\s+)?results?\b.{0,20}\bmean\b|\b(?:interpret|explain) my (?:lab )?(?:results?|report)\b|شو (?:هي )?الجرع[هة]|(?:كم|اي) جرع[هة].{0,30}(?:اخد|اتناول)|شو يعني نتيجتي|ما معنى نتيجتي|نتيج[هة].{0,45}(?:عندي|تبعي).{0,45}(?:شو يعني|هل عندي|عندي مرض)|\b(?:natije|ta7lil)\b.{0,35}\b(?:3ande|taba3e)\b.{0,45}\b(?:shu ya3ne|3ande marad)\b/iu.test(
    text,
  );

const privateRecord = (text) =>
  /\b(?:patient|visitor) names\b|(?:اسماء|اسامي) (?:جميع )?(?:المرضى|المراجعين)|\b(?:asame|asemi)\s+(?:el |l )?(?:marda|mar[dt]a)\b/iu.test(
    text,
  ) ||
  /[\w.+-]+@[\w.-]+|\b(?:WR|LAB|P)-[\da-f-]{6,}|(?:\+?\d[ ().-]*){7,}|\b(?:my|personal)\b.{0,24}\b(?:appointments?|bookings?|reports?|results?|records?|password|account|requests?)\b|\b(?:my id number|patient records?|someone else.?s (?:records?|cedar account|visit history)|(?:their|another patient.?s) (?:lab report|test results?|visit history|medical records?|account)|\b(?:look up|pull up|retrieve|show)\b.{0,65}\b(?:lab report|test results?|visit history)\b.{0,35}\b(?:their|someone else.?s|coworker.?s)\b|reset (?:my )?password|booking status|report status)\b|\b(?:list|show|name)\b.{0,30}\bpatients\b|تلغيلي.{0,20}(?:حجز|موعد)|نتيجتي|موعدي|حجزي|تقريري|سجلي|حسابي|طلبي|كلمة السر|natijte|maw3ade|7sebe/iu.test(
    text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""),
  );

const generalClinical = (text) =>
  (/\bshould i do\b/u.test(text) && !serviceLogistics(text)) ||
  /\b(?:diagnos\w*|prescri\w*|dosage|symptom\w*|treatment|what dose|should i (?:take|stop|get|fast)|interpret\w*|what causes|what is (?:chest pain|a seizure)|can chest pain)\b|تشخيص|جرعة|اعراض|هل اتناول|هل اصوم|علاج|ما معنى الم الصدر|شو يعني وجع|adde.*(?:dose|dawa)|shu.*dawa/iu.test(
    text,
  );

// Prefer explicit acts over broader medical or account vocabulary.
const confirmed = 3;
const plausible = 2;
const categorySignals = [
  ["cancel", [[cancellationRequest, confirmed]]],
  ["private", [[privateResultRequest, confirmed]]],
  [
    "override",
    [
      [instructionConcept, confirmed],
      [
        (text) =>
          /\b(?:ignore|disregard|bypass)\s+(?:(?:the|all|your)\s+)?(?:cedar |clinic |safety )?(?:rules|instructions|restrictions)\b/u.test(
            text,
          ) ||
          /ignore (?:all |your |previous )*(?:rules|instructions)|override|jailbreak|system prompt|(?:private|hidden|internal) (?:operating |setup )?(?:instructions|rules)|(?:translate|repeat|show|reveal|paste|print) (?:all )?your (?:internal )?(?:instructions|rules)|(?:show|print|repeat|quote|reveal)\b.{0,30}\binstructions\b.{0,40}\b(?:you (?:were given|received)|before (?:this |the )?chat)|\b(?:reveal|share|show|print|give me)\b.{0,25}\b(?:private|hidden|internal) rules\b|reveal.*prompt|تجاهل.*(?:تعليمات|قواعد)|(?:اكشف|اظهر|انسخ).*(?:التعليمات|القواعد)|نسيت القواعد|(?:warjine|farjine|ekteble).*(?:ta3limet|ta3limat|system prompt)/i.test(
            text,
          ),
        confirmed,
      ],
    ],
  ],
  [
    "clinical",
    [
      [clinicalInterpretation, confirmed],
      [clinicalConcept, confirmed],
    ],
  ],
  ["private", [[privateRecord, plausible]]],
  ["clinical", [[generalClinical, plausible]]],
  [
    "unrelated",
    [
      [unrelatedConcept, confirmed],
      [
        (text) =>
          /\b(?:weather|forecast|football (?:score|match)|bitcoin price|graphics cards?|gaming (?:pc|computer)|packing list|camping trip|birthday party|playlist for (?:a |my )?party|(?:bicycle|bike) (?:tire|tyre)|flat (?:bicycle|bike) (?:tire|tyre)|write (?:me )?a poem|recipe)\b|\b(?:recommend|find|suggest|where)\b.{0,50}\b(?:restaurants?|cafes?)\b|الطقس|حالة الجو|كيف الجو|جو بكرا|kif.*ta2es/iu.test(
            text,
          ),
        confirmed,
      ],
    ],
  ],
];

export function protectedGate(message) {
  const text = normalize(message);
  if (emergencyDisclosure(text, { includeUncertain: true })) return "emergency";
  const active = activeRequest(text);
  if (!active) return null;
  for (const [category, signals] of categorySignals) {
    const score = signals.reduce(
      (total, [check, weight]) => total + (check(active) ? weight : 0),
      0,
    );
    if (score >= (category === "unrelated" ? confirmed : plausible)) {
      return category;
    }
  }
  return null;
}
