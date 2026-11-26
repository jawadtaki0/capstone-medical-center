import { plain } from "./text.js";
import { readDate, westernDigits } from "./dates.js";

// Plain-code reading of what staff typed. Every value lands in an editable
// field; none of it comes from the model and none of it is trusted.
const ANCHORS = new Set(
  [
    "for",
    "of",
    "book",
    "in",
    "update",
    "edit",
    "patient",
    "register",
    "account",
    "حساب",
    "موظف",
    "موظفه",
    "لموظف",
    "لموظفه",
    "cancel",
    "reschedule",
    "احجز",
    "للمريض",
    "للمريضه",
    "للمريضة",
    "المريض",
    "المريضه",
    "المريضة",
    "موعد",
    "حجز",
    "سجل",
    "الغي",
    "الغ",
  ].map(plain),
);
const SKIPPED = new Set(["patient", "the", "mr", "mrs", "ms"]);
const STOP = new Set(
  [
    ..."phone number details record name address update edit change correct my".split(
      " ",
    ),
    ..."as account staff employee receptionist reception admin administrator clinic role موظف موظفه استقبال حساب مدير".split(
      " ",
    ),
    ..."a an the appointment appointments booking bookings patient new for with on at to of from born dob birth date today tomorrow monday tuesday wednesday thursday friday saturday sunday next this that him her them me my someone visit session dr doctor please how do i and is in lab order test tests result slot place another day time".split(
      " ",
    ),
    ..."بدي بدو بدها بده يريد تريد يلغي تلغي يغير تغير ياجل وصل وصلت اخذ سحب عنده عندها شو كيف هل مريض مريضه المريض المريضه جديد جديده بكرا بكره اليوم غدا بعد يوم مع عند مواليد تاريخ دكتور الدكتور الدكتوره موعد حجز موعده حجزه من على الى الاحد الاثنين التنين الثلاثاء الاربعاء الخميس الجمعه السبت فحص طلب نتيجه اخر تاني".split(
      " ",
    ),
  ].map(plain),
);
const BIRTH = /(born( on)?|dob|date of birth|مواليد|تاريخ (ال)?ولاده)[\s:]*$/;
const DATE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}/g;

function readName(message) {
  const words = message.match(/[\p{L}\p{M}\p{N}'’-]+/gu) ?? [];
  const isName = (word) =>
    word &&
    /^[\p{L}\p{M}'’-]+$/u.test(word) &&
    !STOP.has(plain(word)) &&
    !ANCHORS.has(plain(word));
  for (let i = 0; i < words.length; i++) {
    let start = i + 1;
    let first = words[start];
    // Arabic attaches "for" to the name: لسامي.
    const attached =
      /^ل\p{Script=Arabic}{2,}$/u.test(words[i]) &&
      !ANCHORS.has(plain(words[i])) &&
      !STOP.has(plain(words[i].slice(1)));
    if (attached && i > 0 && ANCHORS.has(plain(words[i - 1]))) {
      start = i;
      first = words[i].slice(1);
    } else {
      if (!ANCHORS.has(plain(words[i]))) continue;
      while (words[start] && SKIPPED.has(plain(words[start]))) start++;
      first = words[start];
      // "حساب موظف لمايا": the account is for مايا.
      if (/^(موظف|موظفه|حساب)$/.test(plain(words[i])) && /^ل../u.test(first))
        first = first.slice(1);
    }
    if (!isName(first)) continue;
    const name = [first];
    while (name.length < 4 && isName(words[start + name.length]))
      name.push(words[start + name.length]);
    if (name.length < 2) continue;
    return {
      firstName: name[0],
      lastName: name.at(-1),
      ...(name.length > 2 ? { fatherName: name[1] } : {}),
    };
  }
  return {};
}

// The request with the person's name and any dates replaced, for matching.
export function withoutDetails(message) {
  let text = westernDigits(message.normalize("NFKC"))
    .replace(DATE, " ")
    .replace(/\b[BP]-\d+\b/gi, " ");
  const name = readName(text);
  const arabic = /\p{Script=Arabic}/u.test(name.firstName ?? "");
  if (name.firstName) {
    // Arabic may attach "for" to the name, so keep it attached to "patient".
    if (arabic && text.includes("ل" + name.firstName))
      text = text.replace("ل" + name.firstName, "للمريض");
    else text = text.replace(name.firstName, arabic ? "المريض" : "the patient");
    text = text.replace(name.lastName, "");
  }
  if (name.fatherName) text = text.replace(name.fatherName, "");
  return text
    .replace(/\b(born( on)?|dob)\b|مواليد/giu, " ")
    .replace(/\s+/g, " ");
}

export function readPrefill(message, today) {
  const found = {};
  let text = westernDigits(message.normalize("NFKC"));
  const order = /\bLAB-[\da-f-]{36}\b/i.exec(text)?.[0];
  if (order) {
    found.orderNumber = "LAB-" + order.slice(4).toLowerCase();
    text = text.replace(order, " ");
  }
  const number = (pattern) => pattern.exec(text)?.[0].toUpperCase();
  const booking = number(/\bB-\d{8,16}\b/i),
    patient = number(/\bP-\d{8,16}\b/i);
  if (booking) found.bookingNumber = booking;
  if (patient) found.patientNumber = patient;
  text = text.replace(/\b[BP]-\d{8,16}\b/gi, " ");
  Object.assign(found, readName(text));
  for (const match of [...text.matchAll(DATE)]) {
    const value = readDate(match[0], today);
    const born = BIRTH.test(plain(text.slice(0, match.index)));
    // A date more than a year old can only be a birth date.
    if (
      value &&
      (born || Number(value.slice(0, 4)) < Number(today.slice(0, 4)) - 1)
    ) {
      found.dateOfBirth = value;
      text = text.replace(match[0], " ");
    }
  }
  const date = readDate(text, today);
  if (date) found.date = date;
  return found;
}
