import { StaffError } from "../errors.js";
import { beirutClock } from "../booking-model.js";
import { allowFields } from "../management-validation.js";
import { TOPICS, TOPIC_IDS, capabilitiesFor, allowedTopics } from "./topics.js";
import { routeMessage } from "./routing.js";
import { readDate } from "./dates.js";

const invalid = () =>
  new StaffError("assistant_input", "Send one short question.", 400);

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
  },
  ar: {
    denied: "دورك لا يشمل هذا الإجراء. هذا ما يمكنني مساعدتك به.",
    unclear: "لم أفهم المقصود. اختر أحد هذه الخيارات أو أعد صياغة السؤال.",
    clinical:
      "لا أستطيع إعطاء نصيحة طبية أو تفسير النتائج. أساعد في مهام Cedar Staff.",
    confirmation_required: "كل تغيير يحتاج إلى تأكيدك. لا يمكنني تخطي ذلك.",
    unavailable: "الأسئلة المكتوبة غير متاحة الآن. استخدم الأزرار.",
    noSessions: "لا توجد جلسات عيادة منشورة وغير منتهية بتاريخ",
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
}) {
  // `lab` is the desktop build flag. It can only narrow what the server allows.
  async function person(token, lab) {
    const at = now();
    const context = await transaction((session) =>
      authenticated(session, token, at),
    );
    const { capabilities } = await summary().read(token);
    return {
      today: beirutClock(at).date,
      capabilities: capabilitiesFor(
        context.account.roles,
        capabilities,
        labEnabled && lab,
      ),
    };
  }
  const button = (id, language) => ({
    topic: id,
    label: TOPICS.find((t) => t.id === id)[language].label,
  });

  return {
    async message(token, input) {
      if (!input || typeof input !== "object") throw invalid();
      allowFields(input, ["text", "topic", "language", "date", "lab"]);
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
      const { capabilities, today } = await person(token, input.lab === true);
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
      if (entry.id === "capabilities")
        return answer("help", copy.reply, { suggestions: offer() });
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
