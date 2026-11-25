// Shared language handling for Ask Cedar's local routes: one normalized form,
// typo tolerance, Arabizi/Arabic name matching and the concept families used
// by safety and policy routes. These rules run before any provider call.
import { specialtyDefinitions } from "../src/data/specialties.js";

// Lowercase, strip Arabic diacritics/tatweel and unify common letter variants.
export const canon = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[’‘`]/g, "'")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632));

// Optimal string alignment distance (adjacent transpositions cost one).
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[a.length][b.length];
}

const vocabulary = [
  ...new Set([
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "tomorrow",
    "today",
    "session",
    "sessions",
    "schedule",
    "available",
    "availability",
    "appointment",
    "morning",
    "afternoon",
    "laboratory",
    "audiometry",
    "hearing",
    "pediatrician",
    "pediatric",
    "children",
    "specialist",
    "doctor",
    "published",
    "window",
    ...specialtyDefinitions.flatMap(({ aliases }) =>
      aliases.flatMap((alias) => alias.toLowerCase().match(/[a-z]{5,}/g) ?? []),
    ),
  ]),
];

// Replace an English word with a close vocabulary word (same first letter).
export function correctTypos(text) {
  return text.replace(/\b[a-z]{5,}\b/g, (word) => {
    if (vocabulary.includes(word)) return word;
    const limit = word.length < 7 ? 1 : 2;
    let best = null;
    let bestDistance = limit + 1;
    for (const candidate of vocabulary) {
      if (candidate[0] !== word[0]) continue;
      if (Math.abs(candidate.length - word.length) > limit) continue;
      const d = distance(word, candidate);
      if (d < bestDistance) {
        best = candidate;
        bestDistance = d;
      }
    }
    return best ?? word;
  });
}

const arabicLetters = {
  ا: "a",
  ب: "b",
  ت: "t",
  ث: "t",
  ج: "j",
  ح: "h",
  خ: "k",
  د: "d",
  ذ: "d",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "s",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "",
  غ: "g",
  ف: "f",
  ق: "k",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ي: "y",
  ء: "",
};

// Consonant outline used to compare names across English, Arabizi and Arabic.
export function skeleton(word) {
  const latin = canon(word)
    .replace(/^(?:ال|al-|el-)/u, "")
    .replace(/[؀-ۿ]/gu, (letter) => arabicLetters[letter] ?? "")
    .replace(/'s$/u, "")
    .replace(/[23]/g, "")
    .replace(/7/g, "h")
    .replace(/5/g, "k")
    .replace(/6/g, "t")
    .replace(/9/g, "s")
    .replace(/8/g, "g")
    .replace(/(?<=[a-z])h/g, "")
    .replace(/q/g, "k")
    .replace(/[^a-z]/g, "")
    .replace(/[aeiouwy]/g, "")
    .replace(/(.)\1+/g, "$1");
  return latin;
}

const titles =
  /^(?:dr|doctor|doc|doktor|daktor|dktor|dr\.|el|al|prof|professor|ms|mrs|mr|miss|specialist|الدكتور|الدكتوره|دكتور|دكتوره|الطبيب|الطبيبه|د|الاخصائي|الاخصائيه|اخصائي|اخصائيه|الاستاذ|الاستاذه|الست|ابو|abou|abu)$/u;

// Tokens of a person's name, without titles or articles.
export const nameTokens = (name) =>
  canon(name)
    .replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !titles.test(token));

// Score how well every token of a requested name matches a published name.
export function nameScore(requested, published) {
  const wanted = nameTokens(requested);
  const available = nameTokens(published);
  if (!wanted.length) return 0;
  let score = 0;
  const used = new Set();
  for (const token of wanted) {
    let best = 0;
    let bestIndex = -1;
    available.forEach((candidate, index) => {
      if (used.has(index)) return;
      const points =
        token === candidate
          ? 3
          : skeleton(token).length >= 2 &&
              skeleton(token) === skeleton(candidate)
            ? 2
            : /^[a-z]{5,}$/.test(token) && distance(token, candidate) <= 1
              ? 2
              : 0;
      if (points > best) {
        best = points;
        bestIndex = index;
      }
    });
    if (!best) return 0;
    used.add(bestIndex);
    score += best;
  }
  return score;
}

const nameStop =
  /^(?:on|at|in|for|have|has|had|is|was|available|listed|published|session|sessions|window|windows|schedule|this|next|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|and|or|please|work|working|see|seeing|open|nhar|yom|يوم|نهار|بكرا|اليوم|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|الاحد|شو|متى|امتى|في|على|عند|بس|هل|وقت|موعد|مواعيد|جلسه|دوام|بيداوم|بيشتغل|بكره|غدا)$/u;

// A clinician named after a title, e.g. "Dr. Zeinab Mkahhel" or "الدكتور غازي سرغاني".
export function requestedProfessional(message) {
  const words = canon(message)
    .replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}.]+/u)
    .filter(Boolean)
    .map((word) => word.replace(/\.$/, ""));
  const start = words.findIndex((word) =>
    /^(?:dr|doctor|doktor|daktor|الدكتور|الدكتوره|دكتور|دكتوره|الطبيب|الطبيبه|الاخصائي|الاخصائيه)$/u.test(
      word,
    ),
  );
  if (start < 0) return "";
  const name = [];
  for (const word of words.slice(start + 1)) {
    if (nameStop.test(word) || name.length === 3) break;
    if (/^\d/.test(word)) break;
    name.push(word);
  }
  return nameTokens(name.join(" ")).length ? name.join(" ") : "";
}

const notGeneral = (text) =>
  !/^(?:what (?:is|are|does|causes)|why |define |explain |ما (?:هو|هي|معنى|اسباب)|شو يعني|شو هو|شو هي)/u.test(
    text,
  ) && !/^(?:if |suppose |hypothetically |لو )/u.test(text);

// Present breathing distress, worded freely.
function breathingDistress(clause) {
  return (
    /\b(?:can'?t|cannot|could ?n'?t|unable to|struggling to|hard to|trouble|difficulty|not able to)\s+(?:\w+\s+){0,2}(?:breath\w*|get (?:enough )?air)\b|\b(?:short(?:ness)? of breath|gasping|choking|suffocat\w*|not getting (?:enough )?air|out of breath)\b/u.test(
      clause,
    ) ||
    /(?:(?:اخد|اخذ|اسحب|اتنفس|تنفس|التنفس)\s*(?:نفس)?.{0,40}(?:مش|ما|ما عم|صعب|عم يضيق|ضيق|ما بيكفي|مش عم)|(?:مش|ما|ما عم|ما عاد|صعب)\s*(?:عم\s*)?(?:بقدر|قادر|قادره|فيني|اقدر|يقدر)?\s*(?:اتنفس|اخد نفس|اخذ نفس)|(?:الهوا|هوا|الهواء)\s*(?:مش|ما)\s*(?:عم\s*)?(?:يكفي|يكفيني|بيكفي|بيكفيني|يفوت|يدخل|يوصل)|ضيق (?:ب|في )?(?:ال)?(?:نفس|تنفس)|(?:نفسي|النفس) (?:مقطوع|عم ينقطع|عم يضيق|ضايق)|عم اختنق|مخنوق|بختنق)/u.test(
      clause,
    ) ||
    /\b(?:mesh|mish|ma|mana|ma3am|ma 3am|sa3eb|sa3b)\b.{0,25}\b(?:etnaffas|etnafas|atnaffas|tnaffas|nafas|nafass|hawa)\b|\b(?:nafas|nafase|nafasi)\b.{0,15}\b(?:ma2tou3|2ate3|dayye2|da2)\b|\bhawa\b.{0,15}\b(?:mesh|ma)\b/u.test(
      clause,
    )
  );
}

// Present thoughts of self-harm or not feeling safe, worded freely.
function selfHarmRisk(clause) {
  if (
    /\b(?:not|never|no longer|don'?t)\s+(?:thinking|going|planning|want)\b.{0,30}\b(?:hurt|harm|kill|suicide)|ما عم فكر|ما بدي ا?(?:اذي|ءذي)|\bma (?:3am fakker|badde)\b/u.test(
      clause,
    )
  )
    return false;
  return (
    /\b(?:hurt|harm|injure|kill|cut|end)\w*\s+(?:my ?self|my life)\b|\bsuicid\w*|\b(?:don'?t|do not) (?:want to (?:live|be alive|wake up)|feel safe)\b|\bnot (?:feeling |feel )?safe (?:with|around) myself\b|\bbetter off dead\b/u.test(
      clause,
    ) ||
    /(?:اذي|ااذي|اءذي|اوذي|ايذاء|اضر|اجرح|اقتل|انهي|اموت)\s*(?:حالي|نفسي|حياتي)|انتحر|انتحار|بدي موت|بدي اموت|ما بدي عيش|(?:مش|ما) (?:حاسس|حاسه|حاس) (?:حالي|نفسي) (?:بامان|امان|بأمان)/u.test(
      clause,
    ) ||
    /\b(?:2?a?2?z+[aei]|2?e?2?z+[aei]|2o?ze|2?azzi|2?a2zi|2?tol|a2tol|2otol|2?2?ezi)\s+(?:nafs[aei]?|7al[aei]?h?|hal[aei]|7ayat[iey])\b|\b(?:enta7er|ente7er|nta7er|ent7er|entehar|enti7ar)\b|\b(?:mesh|mish|ma)\s+(?:7ases|7assa|7ass|7ese)\w*\s+(?:(?:7al[aei]|nafs[aei])\s+)?(?:b?aman)\b|\bbadde? mout\b/u.test(
      clause,
    )
  );
}

// Other present-tense emergencies described in Arabic or Arabizi.
function otherEmergency(clause) {
  return (
    /(?:(?:صدري|قلبي) (?:عم )?(?:يوجعني|بيوجعني|يالمني|عم يضغط)|وجع (?:قوي |كتير )?(?:ب|في )?(?:صدري|الصدر)|ضغط (?:على|ع) صدري|(?:عم|ما عم) (?:ينزف|نزف) (?:كتير|كثير|بقوه)|ما (?:عم )?(?:يوقف|بيوقف) (?:ال)?نزيف|(?:غايب|فاقد|فاقده) (?:عن )?(?:ال)?وعي|ما عم (?:يفيق|يرد|يتنفس)|(?:عم )?(?:يتشنج|بيتشنج)|جلطه (?:هلق|هلا|الان))/u.test(
      clause,
    ) ||
    /\b(?:waja3|wje3)\s+(?:b|bi|fi)?\s*(?:sadre|sadri|sedre)\b|\b(?:sadre|sadri)\s+(?:3am\s+)?(?:yewja3ne|byewja3ne|wej3ne)\b|\b(?:fainted|collapsed|not responding|won'?t wake up|unresponsive|turning blue|seizing)\b/u.test(
      clause,
    )
  );
}

// Urgent disclosures not covered by the original phrase list.
export function urgentConcept(value) {
  return canon(value)
    .split(/[.!?؟؛;]|\bbut\b|لكن|\sبس\s|،|,/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some(
      (clause) =>
        notGeneral(clause) &&
        (breathingDistress(clause) ||
          selfHarmRisk(clause) ||
          otherEmergency(clause)),
    );
}

// Cancelling or deleting an existing booking through chat.
export function cancellationConcept(value) {
  const text = canon(value);
  const verb =
    /\b(?:cancel\w*|call off|delete|remove|withdraw|drop)\b|(?:الغي|الغاء|بلغي|لغي|يلغي|تلغي|تلغيلي|بشطب|اشطب|شطب|تشطب|امسح|بمسح|تمسح|احذف|بحذف|تحذف|شيل|بشيل|تشيل)|\b(?:l8i|elghe|ilghe|2elghe|bl8i|shatb|ashtob|bshtob|emsa7|bemsa7)\b/u;
  const booking =
    /\b(?:booking|appointment|reservation|visit|session|request|slot)s?\b|موعد|مواعيد|حجز|زياره|طلب|جلسه|\b(?:maw3ad|maw3ed|mow3ad|7ajz|7ajez)\b/u;
  const verbMatch = verb.exec(text);
  const bookingMatch = booking.exec(text);
  return Boolean(
    verbMatch &&
      bookingMatch &&
      Math.abs(verbMatch.index - bookingMatch.index) <= 60,
  );
}

// Requests to disclose or override the assistant's own instructions.
export function instructionConcept(value) {
  const text = canon(value);
  const target =
    /\b(?:instructions?|rules|prompt|system prompt|guidelines|directives|configuration|guardrails|programming)\b|تعليمات|التعليمات|قواعد|القواعد|برومبت|\b(?:ta3limet|ta3limat|2awa3ed)\b/u;
  if (!target.test(text)) return false;
  const disclose =
    /\b(?:quote|repeat|reveal|show|print|share|tell me|list|copy|paste|recite|output|leak|dump|display|read out|write out|what (?:are|were) your)\b|(?:اكتب|اكتبلي|اكشف|اظهر|اعرض|انسخ|قلي|قللي|قولي|خبرني|عطيني|اعطني|ورجيني|فرجيني)|\b(?:warjine|farjine|ekteble|2elle|2olle|khabberne)\b/u;
  const own =
    /\b(?:your|you(?:'ve| have| were| got)?|supplied|given|provided|before (?:this|the) (?:conversation|chat)|confidential|hidden|secret|internal|system|developer|original|initial)\b|تبعك|الك|اعطوك|المعطاه|السريه|الداخليه|المخفيه|يلي عندك|\b(?:taba3ak|ta3ak)\b/u;
  const override =
    /\b(?:ignore|disregard|forget|bypass|override)\b.{0,30}\b(?:instructions?|rules|guidelines|prompt)\b|تجاهل|انسى/u;
  return (disclose.test(text) && own.test(text)) || override.test(text);
}

const cedarDomain =
  /\b(?:clinic|clinics|doctors?|dr|appointments?|sessions?|book\w*|schedule|lab|laborator\w*|tests?|blood|urine|stool|audiometry|hearing|cedar|cent(?:er|re)|specialists?|hours|open|close|fasting|sample|results?|reports?|account|health|medical|pediatric\w*|dentist\w*|cardiolog\w*|dermatolog\w*|gyn\w*|urolog\w*|ophthalm\w*|gastro\w*|endocrin\w*|diet\w*|therap\w*|speech|surgery|surgeon|ent|catalogue|catalog|price|cost)\b|عياد|طبيب|دكتور|موعد|مواعيد|حجز|جلس|مختبر|فحص|تحليل|سمع|سيدر|المركز|اختصاص|اخصائي|دوام|نتيج|حساب|\b(?:mokhtabar|maw3ad|7ajz|doktor|daktor|dawam|sama3|fa7s)\b/u;
const offTopic =
  /\b(?:songs?|playlist|music|movies?|films?|poems?|jokes?|stor(?:y|ies)|recipes?|cook\w*|weather|forecast|football|soccer|basketball|match|scores?|bitcoin|crypto\w*|stocks?|games?|gaming|homework|essay|math|equation|code|coding|program(?:ming)?|travel|flights?|hotels?|vacation|holiday|wedding|birthday|party|restaurants?|cafes?|shopping|outfit|lyrics|news|politics?|elections?)\b|اغاني|اغنيه|افلام|فيلم|قصيده|نكته|طبخ|وصفه|الطقس|كره القدم|مباراه|عرس|حفله|عيد ميلاد|سفر|فندق|مطعم/u;
const contentTask =
  /^(?:(?:can|could|would) you |please |pls )?(?:write|compose|create|generate|make|put together|draft|give me|suggest|recommend|plan|list|tell me|translate|summari[sz]e|solve|help me (?:write|plan|choose|pick|with my))\b|^(?:اكتب|اعمل|اقترح|ساعدني|عطيني|اعطني|ترجم)/u;

// Requests unrelated to Cedar's services.
export function unrelatedConcept(value) {
  const text = canon(value)
    .replace(
      /\b(?:wedding|party|hotel|event|birthday)\s+reception\b/gu,
      "event",
    )
    .trim();
  const hasDomain =
    cedarDomain.test(text) || /\breception\b|الاستقبال/u.test(text);
  if (hasDomain) return false;
  return offTopic.test(text) || contentTask.test(text);
}

// Advice about medicines, doses or the meaning of a personal result.
export function clinicalConcept(value) {
  const text = canon(value);
  const medicine =
    /\b(?:medicines?|medications?|meds|drugs?|pills?|tablets?|antibiotics?|supplements?|vitamins?|doses?|dosage|painkillers?|treat(?:ment)?|cure)\b|دوا|الدوا|دواء|ادويه|حبوب|حبه|علاج|مضاد|فيتامين|مكمل|جرعه|مسكن|\b(?:dawa|edwye|7bub|7obob|3ilaj|3elej|dawe)\b/u;
  const advice =
    /\b(?:should|which|what|do i|need|take|use|start|stop|increase|lower|recommend|best|prescribe)\b|لازم|شو|اي|بآخد|باخد|اخد|آخد|اخذ|استعمل|بستعمل|بتنصح|انصح|منيح|ينفع|\b(?:lezem|shu|eh|ekhod|2ekhod|bekhod)\b/u;
  const result =
    /\b(?:results?|levels?|readings?|values?|counts?|numbers?)\b|نتيجه|نتيجتي|تحليل|نسبه|معدل|مستوى|\b(?:natije|ta7lil|nesbe)\b/u;
  const abnormal =
    /\b(?:low|high|elevated|abnormal|positive|borderline|out of range|raised)\b|واطي|واطيه|منخفض|منخفضه|عالي|عاليه|مرتفع|مرتفعه|طالع|طالعه|نازل|نازله|ناقص|\b(?:wa6e|wati|3ali|3alye|nezle|tal3a)\b/u;
  const meaning =
    /\b(?:mean|means|worried|serious|dangerous|bad|normal|what should|what do i)\b|شو يعني|يعني شي|خطير|خطر|طبيعي|شو بعمل|شو لازم|\b(?:shu ya3ne|khatir)\b/u;
  return (
    (medicine.test(text) && advice.test(text)) ||
    (result.test(text) &&
      abnormal.test(text) &&
      (meaning.test(text) || medicine.test(text)))
  );
}

// Questions about prices, fees or costs.
export const priceConcept = (value) =>
  /\b(?:prices?|pricing|priced|costs?|costing|fees?|charges?|cheap\w*|expensive|how much (?:is|does|do|would|will|for)|afford\w*)\b|سعر|اسعار|تكلفه|كلفه|بكلف|يكلف|قديش|كم (?:حق|سعر|بيكلف)|\b(?:se3r|se3er|as3ar|2adesh|addesh|adde|kalfe|bikallef)\b/u.test(
    canon(value),
  );

// Whether choosing a window means the visit is confirmed.
export const confirmationConcept = (value) => {
  const text = canon(value);
  return (
    /\b(?:choos\w*|select\w*|pick\w*|submit\w*|send\w*|click\w*|request\w*)\b|اختيار|اختار|اخترت|بختار|نقيت|بنقي|ارسال|ارسلت|بعتت|ببعت|طلب/u.test(
      text,
    ) &&
    /\b(?:confirm\w*|reserv\w*|guarantee\w*|booked|final|secured?)\b|تاكد|تأكد|مأكد|ماكد|مؤكد|مضمون|محجوز|ثابت|انحجز|اتحجز/u.test(
      text,
    )
  );
};
