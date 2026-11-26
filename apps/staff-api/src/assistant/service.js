import { StaffError } from "../errors.js";
import { beirutClock } from "../booking-model.js";
import { allowFields } from "../management-validation.js";
import { TOPICS, TOPIC_IDS, capabilitiesFor, allowedTopics } from "./topics.js";
import { routeMessage } from "./routing.js";
import { plain } from "./text.js";
import { readDate, readDates } from "./dates.js";
import { readPrefill } from "./prefill.js";

const invalid = () =>
  new StaffError("assistant_input", "Send one short question.", 400);

const TASKS = {
  book_help: "book",
  cancel_booking_help: "cancel",
  reschedule_help: "reschedule",
  lab_order_help: "labCreate",
  lab_collect_help: "collect",
  lab_cancel_help: "labCancel",
  lab_release_help: "release",
  lab_prepare_help: "labPrepare",
  limit_change: "limit",
  absence: "absence",
  staff_create: "staffCreate",
  checkin_help: "checkin",
  walkin: "walkin",
  publish: "publish",
  requests_help: "request",
  patient_update: "patientUpdate",
  recollect: "recollect",
  reopen: "reopen",
  withdraw: "withdraw",
  catalogue: "catalogue",
  schedule_help: "schedule",
};
const WINDOW_DAYS = 28;
const ATTENTION = [
  ["requestsAwaitingDecision", "requests", undefined],
  ["messagesToSend", "requests", "messages"],
  ["trackingDeliveryProblems", "requests", undefined],
  ["todayBookings", "bookings", undefined],
  ["unpublishedChanges", "website-updates", undefined],
  ["publicationDeliveryProblems", "website-updates", undefined],
];
const COUNT_LABELS = {
  en: {
    requestsAwaitingDecision: "Requests awaiting decision",
    messagesToSend: "Messages to send",
    trackingDeliveryProblems: "Tracking delivery problems",
    todayBookings: "Today's bookings",
    unpublishedChanges: "Unpublished changes",
    publicationDeliveryProblems: "Website delivery problems",
  },
  ar: {
    requestsAwaitingDecision: "طلبات بانتظار القرار",
    messagesToSend: "رسائل للإرسال",
    trackingDeliveryProblems: "مشاكل في تسليم التتبع",
    todayBookings: "حجوزات اليوم",
    unpublishedChanges: "تغييرات غير منشورة",
    publicationDeliveryProblems: "مشاكل في تحديث الموقع",
  },
};
const addDays = (day, count) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};
const publicSession = (s) =>
  Object.fromEntries(
    [
      "id",
      "date",
      "scopeId",
      "sourceSessionId",
      "version",
      "professionalId",
      "professionalName",
      "specialty",
      "clinicName",
      "startTime",
      "endTime",
      "capacity",
      "remaining",
    ].map((k) => [k, s[k]]),
  );

const REPLIES = {
  en: {
    denied: "Your role does not include that. Here is what I can help with.",
    unclear:
      "I am not sure what you mean. Pick one of these, or say it another way.",
    clinical:
      "I cannot give medical advice or interpret results. I help with Cedar Staff tasks.",
    confirmation_required:
      "Every change needs your confirmation. I cannot skip that step.",
    unavailable: "Typed questions are unavailable right now. Use the buttons.",
    noSessions: "No published, unended clinic sessions on",
    form: "Fill in the form below. Nothing is saved until you confirm.",
    quiet: "Nothing in your Today counts needs attention right now.",
  },
  ar: {
    denied: "دورك لا يشمل هذا الإجراء. هذا ما يمكنني مساعدتك به.",
    unclear: "لم أفهم المقصود. اختر أحد هذه الخيارات أو أعد صياغة السؤال.",
    clinical:
      "لا أستطيع إعطاء نصيحة طبية أو تفسير النتائج. أساعد في مهام Cedar Staff.",
    confirmation_required: "كل تغيير يحتاج إلى تأكيدك. لا يمكنني تخطي ذلك.",
    unavailable: "الأسئلة المكتوبة غير متاحة الآن. استخدم الأزرار.",
    noSessions: "لا توجد جلسات عيادة منشورة وغير منتهية بتاريخ",
    form: "املأ النموذج أدناه. لا يُحفظ أي شيء قبل أن تؤكد.",
    quiet: "لا يوجد في أرقام اليوم ما يحتاج انتباهك الآن.",
  },
};

// Reads only. Every fact comes from an existing service called with the same
// token, so that service's own permission checks apply.
export function createAssistantService({
  transaction,
  authenticated,
  now,
  summary,
  bookings,
  matcher,
  labEnabled,
  chats,
}) {
  // `lab` is the desktop build flag. It can only narrow what the server allows.
  async function person(token, lab) {
    const at = now();
    const context = await transaction((session) =>
      authenticated(session, token, at),
    );
    const { capabilities, counts } = await summary().read(token);
    return {
      counts,
      today: beirutClock(at).date,
      capabilities: capabilitiesFor(
        context.account.roles,
        capabilities,
        labEnabled && lab,
      ),
    };
  }
  // A named doctor is matched against published sessions, never guessed.
  async function professionalIn(token, text, date) {
    const words = new Set(plain(text).match(/\p{L}{3,}/gu) ?? []);
    const found = await bookings().sessions(token, { date });
    const matches = new Set(
      found.sessions
        .filter((s) =>
          (plain(s.professionalName).match(/\p{L}{3,}/gu) ?? []).some((w) =>
            words.has(w),
          ),
        )
        .map((s) => s.professionalId),
    );
    return matches.size === 1 ? [...matches][0] : undefined;
  }
  async function task(token, type, text, today) {
    const prefill = text === undefined ? {} : readPrefill(text, today);
    if (type === "book" && text !== undefined) {
      const date = prefill.date >= today ? prefill.date : today;
      const professionalId = await professionalIn(token, text, date);
      if (professionalId) prefill.professionalId = professionalId;
    }
    if (type === "absence" && text !== undefined) {
      const dates = readDates(text, today);
      if (dates.length) prefill.dates = dates;
    }
    return { type, prefill, today };
  }
  const button = (id, language) => ({
    topic: id,
    label: TOPICS.find((t) => t.id === id)[language].label,
  });

  return {
    // Later sessions with places: the same professional, or on request other
    // professionals in the same specialty.
    async alternatives(token, input) {
      if (!input || typeof input !== "object") throw invalid();
      allowFields(input, ["professionalId", "date", "specialty"]);
      if (
        typeof input.professionalId !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "") ||
        (input.specialty !== undefined &&
          (typeof input.specialty !== "string" || input.specialty.length > 120))
      )
        throw invalid();
      const { capabilities, today } = await person(token, false);
      if (!capabilities.book)
        throw new StaffError(
          "booking_forbidden",
          "Your current roles do not permit booking.",
          403,
        );
      const first = input.date > today ? input.date : today;
      const sessions = [];
      for (let i = 0; i < WINDOW_DAYS && sessions.length < 10; i++) {
        const found = await bookings().sessions(token, {
          date: addDays(first, i),
        });
        for (const s of found.sessions) {
          const wanted =
            input.specialty === undefined
              ? s.professionalId === input.professionalId
              : s.professionalId !== input.professionalId &&
                s.specialty === input.specialty;
          if (wanted && s.canBook && s.remaining > 0)
            sessions.push(publicSession(s));
        }
      }
      return { sessions: sessions.slice(0, 10), days: WINDOW_DAYS };
    },
    // The reply is built from this question alone. With a chat ID it is also
    // saved for its owner; saved turns are never read back to answer.
    async message(token, input) {
      const id = input?.chatId;
      if (id === undefined) return this.answer(token, input);
      await chats.assertWritable(token, id);
      const reply = await this.answer(token, input);
      const question =
        input.text?.trim() ??
        TOPICS.find((t) => t.id === input.topic)[reply.language].label;
      // Availability is a fact of the moment, so it is not kept.
      const { sessions, items, task, ...kept } = reply;
      const turnId = await chats.append(token, id, question, {
        ...kept,
        ...(sessions || items ? { stale: true } : {}),
        ...(task ? { task: { type: task.type, prefill: task.prefill } } : {}),
      });
      return { ...reply, turnId };
    },
    async answer(token, input) {
      if (!input || typeof input !== "object") throw invalid();
      allowFields(input, [
        "text",
        "topic",
        "language",
        "date",
        "lab",
        "chatId",
      ]);
      const { text, topic } = input;
      if (
        (text === undefined) === (topic === undefined) ||
        (text !== undefined &&
          (typeof text !== "string" || !text.trim() || text.length > 500)) ||
        (topic !== undefined && !TOPIC_IDS.includes(topic)) ||
        (input.language !== undefined &&
          !["en", "ar"].includes(input.language)) ||
        (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) ||
        (input.lab !== undefined && typeof input.lab !== "boolean")
      )
        throw invalid();
      const { capabilities, today, counts } = await person(
        token,
        input.lab === true,
      );
      const allowed = allowedTopics(capabilities);
      let routed = {
        kind: "topic",
        topic,
        language: input.language ?? "en",
        suggestions: [],
      };
      if (text !== undefined)
        try {
          routed = await routeMessage(text.trim(), matcher);
        } catch {
          // A missing model file must not block the buttons.
          routed = await routeMessage(text.trim(), null);
        }
      const { language } = routed;
      const replies = REPLIES[language];
      const offer = (ids = []) =>
        [...new Set([...ids, ...allowed])]
          .filter((id) => allowed.includes(id) && id !== "capabilities")
          .slice(0, ids.length ? 3 : allowed.length)
          .map((id) => button(id, language));
      const answer = (kind, reply, extra = {}) => ({
        language,
        kind,
        reply,
        steps: [],
        actions: [],
        suggestions: [],
        ...extra,
      });

      if (routed.kind !== "topic")
        return answer(routed.kind, replies[routed.kind], {
          suggestions: offer(routed.suggestions),
        });
      const entry = TOPICS.find((t) => t.id === routed.topic);
      if (!allowed.includes(entry.id))
        return answer("denied", replies.denied, { suggestions: offer() });
      const copy = entry[language];
      const actions = entry.view ? [{ view: entry.view }] : [];
      if (entry.id === "attention") {
        const items = ATTENTION.filter(([id]) => counts[id] > 0).map(
          ([id, view, tab]) => ({
            id,
            label: COUNT_LABELS[language][id],
            count: counts[id],
            view,
            ...(tab ? { tab } : {}),
          }),
        );
        return answer("attention", items.length ? copy.reply : replies.quiet, {
          items,
        });
      }
      if (entry.id === "capabilities")
        return answer("help", copy.reply, { suggestions: offer() });
      if (TASKS[entry.id]) {
        const prepared = await task(token, TASKS[entry.id], text, today);
        // Schedule forms read the doctor and numbers from the question itself.
        const filled =
          Object.keys(prepared.prefill).length > 0 ||
          (text !== undefined && prepared.type === "limit" && /\d/.test(text));
        return answer("task", filled ? replies.form : copy.reply, {
          steps: filled ? [] : copy.steps,
          actions,
          task: { ...prepared, open: filled },
        });
      }
      if (entry.id !== "sessions")
        return answer("help", copy.reply, { steps: copy.steps, actions });

      const date = input.date ?? (text && readDate(text, today)) ?? today;
      const found = await bookings().sessions(token, { date });
      return answer(
        "sessions",
        found.sessions.length
          ? `${copy.reply} ${date}`
          : `${replies.noSessions} ${date}`,
        {
          date,
          actions,
          sessions: found.sessions.map((s) => ({
            id: s.id,
            professionalName: s.professionalName,
            clinicName: s.clinicName,
            startTime: s.startTime,
            endTime: s.endTime,
            capacity: s.capacity,
            remaining: s.remaining,
          })),
        },
      );
    },
  };
}
