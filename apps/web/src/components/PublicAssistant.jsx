import AssistantAccountCards from "./AssistantAccountCards.jsx";
import { cancelChatCopy } from "../../server/public-assistant-account.js";
import {
  protectedGate,
  rulesCopy,
} from "../../server/public-assistant-gate.js";
import {
  browserPublicRequest,
  localRoute,
} from "../../server/public-assistant-context.js";
import {
  addDays,
  cedarToday,
  resolveBeirutDate,
} from "../../server/public-assistant-dates.js";
import { intentLabels } from "../../server/public-assistant-intent-labels.js";
import {
  symptomRequest,
  standaloneArabizi,
} from "../../server/public-assistant-demo.js";
import { questionLanguage } from "../../server/public-assistant-demo-turns.js";
import { createRequestClient } from "../website-request-client.js";
import {
  canon,
  requestedProfessional,
} from "../../server/public-assistant-language.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { emergencyLine, receptionHandoff } from "../public-assistant-safety.js";
import "./public-assistant.css";

const publicCatalogue = createRequestClient({
  apiOrigin:
    import.meta.env.VITE_HOSTED_CAPSTONE === "1"
      ? import.meta.env.VITE_CAPSTONE_API_ORIGIN
      : import.meta.env.VITE_HOSTED_REVIEW === "1"
        ? import.meta.env.VITE_REVIEW_API_ORIGIN
        : "",
});
const labels = {
  en: {
    open: "Ask Cedar",
    close: "Close",
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    cedar: "Cedar",
    you: "You",
    title: "Cedar assistant",
    welcome: "How can we help?",
    allTopics: "All topics",
    personal: "My account and care",
    language: "Language",
    help: "Ask about public Clinic sessions and Lab information. Keep personal details out of chat.",
    input: "Your question",
    topicsLabel: "Guided help",
    menuLabel: "Choose a topic",
    menu: {
      hours: "Hours",
      doctor: "Find a doctor",
      prices: "Prices",
      preparation: "Preparation",
      register: "Register",
      about: "About Ask Cedar",
    },
    pick: "Choose",
    schedule: "Open the schedule",
    topics: {
      urgent: "Urgent help",
      private: "My results",
      bookings: "My bookings",
      cancel: "Cancel or reschedule",
      clinical: "Medical advice",
    },
    send: "Send",
    busy: "Checking…",
    reception: "Contact Reception",
    details: "See public information",
    account: "Open My account",
    signedInAccount:
      "You’re signed in. Open My account to manage your records.",
    signedInResults:
      "View released Lab reports for yourself or a linked child.",
    signedInBookings: "View booking requests for yourself or a linked child.",
    labResults: "Open secure Lab results",
    choose: "Open request form",
    source: "Source",
    sample: "Sample",
    failed:
      "The assistant is temporarily unavailable. Try again or contact Reception.",
  },
  ar: {
    open: "اسأل سيدر",
    close: "إغلاق",
    minimize: "تصغير",
    maximize: "تكبير",
    restore: "استعادة الحجم",
    cedar: "سيدر",
    you: "أنت",
    title: "مساعد سيدر",
    welcome: "كيف يمكننا المساعدة؟",
    allTopics: "كل المواضيع",
    personal: "حسابي ورعايتي",
    language: "اللغة",
    help: "اسأل عن جلسات العيادة المنشورة ومعلومات المختبر. تجنّب كتابة معلومات شخصية.",
    input: "سؤالك",
    topicsLabel: "مساعدة حسب الموضوع",
    menuLabel: "اختر موضوعًا",
    menu: {
      hours: "ساعات العمل",
      doctor: "ابحث عن طبيب",
      prices: "الأسعار",
      preparation: "التحضير",
      register: "تسجيل طلب",
      about: "عن اسأل سيدر",
    },
    pick: "اختر",
    schedule: "افتح الجدول",
    topics: {
      urgent: "مساعدة طارئة",
      private: "نتائجي",
      bookings: "حجوزاتي",
      cancel: "إلغاء الموعد أو تغييره",
      clinical: "استشارة طبية",
    },
    send: "إرسال",
    busy: "جارٍ التحقق…",
    reception: "تواصل مع الاستقبال",
    details: "عرض المعلومات العامة",
    account: "افتح حسابي",
    signedInAccount: "أنت مسجّل الدخول. افتح حسابي لإدارة سجلاتك.",
    signedInResults:
      "اعرض نتائج المختبر الصادرة لك أو لأحد أطفالك المرتبطين بحسابك.",
    signedInBookings: "اعرض طلبات المواعيد لك أو لأحد أطفالك المرتبطين بحسابك.",
    labResults: "افتح نتائج المختبر الآمنة",
    choose: "افتح نموذج الطلب",
    source: "المصدر",
    sample: "العينة",
    failed: "المساعد غير متاح مؤقتًا. حاول مجددًا أو تواصل مع الاستقبال.",
  },
};

export default function PublicAssistant({ account, onAccount }) {
  const opener = useRef(null);
  const panel = useRef(null);
  const closeButton = useRef(null);
  const history = useRef(null);
  const latestReply = useRef(null);
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const publicContext = useRef(null);
  const [language, setLanguage] = useState(
    document.documentElement.lang === "ar" ? "ar" : "en",
  );
  const [turns, setTurns] = useState([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [privatePanel, setPrivatePanel] = useState(null);
  const invalidateAccount = useCallback(() => onAccount?.(null), [onAccount]);
  const requestGeneration = useRef(0);
  const accountEmail = account?.email;
  useEffect(() => {
    if (accountEmail) setPrivatePanel(null);
    else
      setPrivatePanel((current) =>
        current ? { ...current, profileId: undefined } : current,
      );
  }, [accountEmail]);
  const [showTopics, setShowTopics] = useState(false);
  const copy = labels[language];
  const latest = turns.at(-1);
  // One emergency line, always in view. The urgent reply already says it.
  const footerLanguage =
    privatePanel?.language ?? latest?.replyLanguage ?? language;
  let privateText = privatePanel?.text;
  if (privatePanel?.intent) {
    const { intent, language: panelLanguage } = privatePanel;
    const panelCopy = labels[panelLanguage];
    if (account) {
      privateText =
        {
          my_results: panelCopy.signedInResults,
          where_results: panelCopy.signedInResults,
          my_bookings: panelCopy.signedInBookings,
          booking_status: panelCopy.signedInBookings,
          cancel_request: cancelChatCopy[panelLanguage],
          sign_in: panelCopy.signedInAccount,
        }[intent] ?? privateText;
    } else if (account === undefined) {
      privateText = panelCopy.busy;
    } else {
      privateText = rulesCopy[panelLanguage].private;
    }
  }
  const urgentShown =
    !privatePanel &&
    latest &&
    (latest.answer.parts ?? [latest.answer]).every(
      (part) => part.kind === "emergency",
    );
  function close() {
    requestGeneration.current++;
    publicContext.current = null;
    setPrivatePanel(null);
    setBusy(false);
    setOpen(false);
    opener.current.focus();
  }
  useEffect(() => {
    if (!open) return;
    closeButton.current.focus();
    const viewport = window.visualViewport;
    function fit() {
      const height = viewport?.height ?? window.innerHeight;
      const inset = Math.max(
        0,
        window.innerHeight - height - (viewport?.offsetTop ?? 0),
      );
      panel.current.style.setProperty("--cedar-visible-height", height + "px");
      panel.current.style.setProperty("--cedar-keyboard-inset", inset + "px");
    }
    fit();
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    window.addEventListener("resize", fit);
    return () => {
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const log = history.current;
    // Start reading at the top of the newest exchange.
    if (privatePanel || (!busy && !latestReply.current)) {
      log.scrollTop = 0;
    } else if (!busy && latestReply.current) {
      log.scrollTop +=
        latestReply.current.parentElement.getBoundingClientRect().top -
        log.getBoundingClientRect().top;
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }, [open, turns, busy, privatePanel]);
  async function send(value, control) {
    if (busy || !value) return;
    setShowTopics(false);
    const generation = ++requestGeneration.current;
    setPrivatePanel(null);
    if (!control) {
      const route = localRoute(value);
      if (
        route?.category ||
        ["override", "unrelated"].includes(protectedGate(value))
      )
        publicContext.current = null;
      if (route) {
        const { category, intent } = route;
        const replyLanguage = /\p{Script=Arabic}/u.test(value)
          ? "ar"
          : language;
        const candidates = (account?.profiles ?? []).filter(
          (p) =>
            p.relationship === "child" &&
            [p.firstName, p.lastName].every(Boolean) &&
            canon(value).includes(canon(p.firstName + " " + p.lastName)),
        );
        publicContext.current = null;
        setQuestion("");
        setPrivatePanel({
          generation,
          intent,
          language: replyLanguage,
          urgent: category === "emergency",
          profileId: candidates.length === 1 ? candidates[0].id : undefined,
          text:
            intent === "cancel_request" && account
              ? cancelChatCopy[replyLanguage]
              : rulesCopy[replyLanguage][
                  category === "emergency" ||
                  category === "clinical" ||
                  (account && category === "cancel")
                    ? category
                    : "private"
                ],
        });
        return;
      }
    }
    if (!control) setQuestion("");
    if (control?.topic) publicContext.current = null;
    const saved = publicContext.current;
    const context =
      saved && Date.now() - saved.at < 600_000 ? saved.value : null;
    setBusy(true);
    const replyLanguage = control
      ? language
      : questionLanguage(value, language);
    let answer;
    let label = control ? value : "";
    let request = control;
    try {
      if (!control && !standaloneArabizi(value) && !symptomRequest(value)) {
        const today = cedarToday();
        request = browserPublicRequest(value, context, today);
        if (!request && requestedProfessional(value)) {
          const day = resolveBeirutDate(value, today, {
            shownDate: context?.date,
          }).day;
          const validDay = day && day >= today && day <= addDays(today, 6);
          const days = validDay
            ? [day]
            : Array.from({ length: 7 }, (_, i) => addDays(today, i));
          const published = (
            await Promise.all(
              days.map((date) =>
                publicCatalogue("sessions?date=" + date).catch(() => []),
              ),
            )
          ).flat();
          request = browserPublicRequest(value, context, today, published);
        }
        const intent =
          request?.intent === "schedule"
            ? "clinicSchedule"
            : request?.intent === "hours"
              ? {
                  center: "centerHours",
                  laboratory: "labHours",
                  audiometry: "audioHours",
                }[request.service]
              : request?.intent;
        label = intentLabels[intent]?.[replyLanguage] ?? "";
      }
      if (!request) throw Error();
      if (generation !== requestGeneration.current) return;
      const res = await fetch("/api/public-assistant", {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: replyLanguage,
          message: request,
          context,
        }),
        signal: AbortSignal.timeout(55_000),
      });
      if (!res.ok) throw Error();
      answer = await res.json();
      if (typeof answer.text !== "string") throw Error();
      if (generation !== requestGeneration.current) return;
      publicContext.current = answer.context
        ? { value: answer.context, at: Date.now() }
        : null;
    } catch {
      if (generation !== requestGeneration.current) return;
      publicContext.current = null;
      answer = control?.topic
        ? { kind: "failure", text: copy.failed }
        : { kind: "failure", text: receptionHandoff[replyLanguage] };
    }
    if (answer.accountIntent) {
      setPrivatePanel({
        generation,
        intent: answer.accountIntent,
        language: answer.language ?? language,
        text:
          answer.accountIntent === "cancel_request" && !account
            ? rulesCopy[answer.language ?? language].private
            : answer.text,
      });
      setBusy(false);
      return;
    }
    setTurns((current) => [
      ...current,
      {
        question: answer.fallback || answer.kind === "failure" ? "" : label,
        answer,
        replyLanguage: answer.language ?? replyLanguage,
      },
    ]);
    setBusy(false);
  }

  const choose = (menu, label) => send(label, { menu });

  const topicButton = ([topic, label], className, onClick) => (
    <button
      key={topic}
      data-selected={
        Boolean(
          privatePanel &&
            {
              private: "my_results",
              bookings: "my_bookings",
              cancel: "cancel_request",
            }[topic] === privatePanel.intent,
        ) || undefined
      }
      type="button"
      className={"button " + className}
      disabled={busy}
      onClick={() => onClick(topic, label)}
    >
      {label}
    </button>
  );
  const { urgent, ...personal } = copy.topics;
  const topicList = (
    <>
      <div
        className="cedar-assistant-menu"
        role="group"
        aria-label={copy.menuLabel}
      >
        {Object.entries(copy.menu).map((entry) =>
          topicButton(entry, "cedar-assistant-topic", (topic, label) =>
            choose({ topic }, label),
          ),
        )}
      </div>
      <p className="cedar-assistant-group-title">{copy.personal}</p>
      <div
        className="cedar-assistant-personal"
        role="group"
        aria-label={copy.topicsLabel}
      >
        {Object.entries(personal).map((entry) =>
          topicButton(entry, "cedar-assistant-quiet", (topic, label) =>
            send(label, { topic }),
          ),
        )}
      </div>
    </>
  );

  return (
    <>
      <button
        ref={opener}
        className="button button-primary cedar-assistant-open"
        type="button"
        aria-expanded={open}
        aria-controls="cedar-assistant-panel"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {copy.open}
      </button>
      {open && (
        <aside
          id="cedar-assistant-panel"
          ref={panel}
          role="region"
          className={`cedar-assistant${maximized ? " cedar-assistant-max" : ""}`}
          dir={language === "ar" ? "rtl" : "ltr"}
          lang={language}
          aria-labelledby="cedar-assistant-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.target.closest("dialog")) {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="cedar-assistant-header">
            <h2 id="cedar-assistant-title">{copy.title}</h2>
            <select
              aria-label={copy.language}
              value={language}
              disabled={busy}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
            <div className="cedar-assistant-controls">
              <button
                type="button"
                className="button button-secondary"
                aria-label={maximized ? copy.restore : copy.maximize}
                title={maximized ? copy.restore : copy.maximize}
                onClick={() => setMaximized((value) => !value)}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                >
                  <path d="M6 5V3h7v7h-2M3 6h7v7H3z" />
                </svg>
              </button>
              <button
                ref={closeButton}
                type="button"
                className="button button-secondary"
                aria-label={copy.minimize}
                title={copy.minimize}
                onClick={close}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                >
                  <path d="M3 8h10" />
                </svg>
              </button>
            </div>
          </div>
          <div
            ref={history}
            className="cedar-assistant-turns"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            tabIndex={0}
            aria-label={copy.title}
          >
            {(!turns.length || privatePanel || showTopics) && topicList}
            {turns.map(({ question, answer, replyLanguage }, index) => (
              <section key={index} hidden={Boolean(privatePanel)}>
                {question && (
                  <div className="cedar-assistant-question">
                    <span className="cedar-assistant-hidden">{copy.you}</span>
                    <p dir="auto">{question}</p>
                  </div>
                )}
                <div
                  className="cedar-assistant-reply"
                  ref={index === turns.length - 1 ? latestReply : null}
                >
                  <span className="cedar-assistant-hidden">{copy.cedar}</span>
                  {(answer.parts ?? [answer]).map((part, partIndex) => (
                    <div
                      key={partIndex}
                      className="cedar-assistant-answer-part"
                    >
                      <p dir="auto">{part.text}</p>
                      <div className="cedar-assistant-cards">
                        {part.cards?.map((card) => (
                          <article key={card.href ?? card.id}>
                            <h3 dir="auto">{card.professional ?? card.name}</h3>
                            {card.href ? (
                              <>
                                <p dir="auto">{card.specialty}</p>
                                <p dir="ltr">
                                  {card.date} · {card.start}–{card.end}
                                </p>
                                <a
                                  className="button button-secondary"
                                  href={
                                    replyLanguage === "ar"
                                      ? card.href + "&lang=ar"
                                      : card.href
                                  }
                                >
                                  {copy.choose}
                                </a>
                              </>
                            ) : (
                              <>
                                <p dir="auto">{card.description}</p>
                                <p>
                                  {copy.sample}: <bdi>{card.sample}</bdi>
                                </p>
                                {card.source && (
                                  <a href={card.source}>{copy.source}</a>
                                )}
                              </>
                            )}
                          </article>
                        ))}
                      </div>
                      {part.page && (
                        <a className="cedar-assistant-more" href={part.page}>
                          {part.page === "/account"
                            ? copy.account
                            : part.page === "/schedule"
                              ? copy.schedule
                              : part.page === "/account#lab-results"
                                ? copy.labResults
                                : part.kind === "private"
                                  ? copy.account
                                  : copy.details}
                        </a>
                      )}
                      {([
                        "failure",
                        "unavailable",
                        "empty",
                        "reception",
                        "laboratory",
                        "labs",
                        "private",
                        "clinical",
                      ].includes(part.kind) ||
                        part.reception) && (
                        <p>
                          <a
                            className="cedar-assistant-reception"
                            href="/#contact"
                          >
                            {copy.reception}{" "}
                            <span aria-hidden="true">
                              {language === "ar" ? "←" : "→"}
                            </span>
                          </a>
                        </p>
                      )}
                      {index === turns.length - 1 &&
                        !!part.intentOptions?.length && (
                          <div className="cedar-assistant-chips">
                            {part.intentOptions.map(({ id, label, action }) => (
                              <button
                                key={id}
                                type="button"
                                className="button button-secondary"
                                disabled={busy}
                                onClick={() => send(label, { action })}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}

                      {index === turns.length - 1 &&
                        Boolean(part.menuOptions?.length) &&
                        (part.menuOptions.length > 6 ? (
                          <label>
                            {copy.pick}
                            <select
                              value=""
                              disabled={busy}
                              onChange={(event) => {
                                const option = part.menuOptions.find(
                                  ({ choice }) => choice === event.target.value,
                                );
                                choose(
                                  {
                                    topic: option.topic,
                                    choice: option.choice,
                                  },
                                  option.label,
                                );
                              }}
                            >
                              <option value="" disabled>
                                {copy.pick}
                              </option>
                              {part.menuOptions.map(({ choice, label }) => (
                                <option key={choice} value={choice}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <div className="cedar-assistant-chips">
                            {part.menuOptions.map(
                              ({ topic, choice, label }) => (
                                <button
                                  key={choice ?? topic}
                                  type="button"
                                  className="button button-secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    choose({ topic, choice }, label)
                                  }
                                >
                                  {label}
                                </button>
                              ),
                            )}
                          </div>
                        ))}
                      {index === turns.length - 1 &&
                        Boolean(part.dateOptions?.length) && (
                          <label>
                            {replyLanguage === "ar"
                              ? "اختر تاريخًا متاحًا"
                              : "Choose an available date"}
                            <select
                              value=""
                              disabled={busy}
                              onChange={(event) =>
                                part.menu
                                  ? choose(
                                      {
                                        ...part.menu,
                                        date: event.target.value,
                                      },
                                      event.target.value,
                                    )
                                  : send(event.target.value, {
                                      action: part.dateAction,
                                      date: event.target.value,
                                    })
                              }
                            >
                              <option value="" disabled>
                                {replyLanguage === "ar" ? "التاريخ" : "Date"}
                              </option>
                              {part.dateOptions.map((date) => (
                                <option key={date} value={date}>
                                  {date}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      {index === turns.length - 1 &&
                        Boolean(part.topicOptions?.length) && (
                          <div className="cedar-assistant-chips">
                            {part.topicOptions.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="button button-secondary"
                                disabled={busy}
                                onClick={() =>
                                  send(copy.topics[id], { topic: id })
                                }
                              >
                                {copy.topics[id]}
                              </button>
                            ))}
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {busy && (
              <div className="cedar-assistant-wait" role="status">
                <span className="cedar-assistant-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {copy.busy}
              </div>
            )}
            {privatePanel && (
              <div
                className="cedar-assistant-private"
                lang={privatePanel.language}
                dir={privatePanel.language === "ar" ? "rtl" : "ltr"}
              >
                <p
                  className={
                    account &&
                    ["my_results", "my_bookings", "booking_status"].includes(
                      privatePanel.intent,
                    )
                      ? "cedar-assistant-hidden"
                      : undefined
                  }
                >
                  {privateText}
                </p>
                {privatePanel.intent && account !== undefined && (
                  <AssistantAccountCards
                    key={
                      privatePanel.generation +
                      ":" +
                      (accountEmail ?? "signed-out")
                    }
                    intent={privatePanel.intent}
                    account={account}
                    preferredProfileId={privatePanel.profileId}
                    language={privatePanel.language}
                    onExpire={invalidateAccount}
                  />
                )}
              </div>
            )}
          </div>
          <div className="cedar-assistant-bar">
            {turns.length > 0 && (
              <button
                type="button"
                className="button cedar-assistant-quiet cedar-assistant-topics-toggle"
                aria-expanded={showTopics}
                onClick={() => setShowTopics((value) => !value)}
              >
                {copy.allTopics}
              </button>
            )}
            {topicButton(
              ["urgent", urgent],
              "cedar-assistant-urgent",
              (topic, label) => send(label, { topic }),
            )}
          </div>
          <form
            className="cedar-assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send(question.trim());
            }}
          >
            <label
              className="cedar-assistant-hidden"
              htmlFor="cedar-assistant-question"
            >
              {copy.input}
            </label>
            <input
              id="cedar-assistant-question"
              value={question}
              placeholder={copy.input}
              dir="auto"
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={400}
              required
              autoComplete="off"
            />
            <button className="button button-primary" disabled={busy}>
              {copy.send}{" "}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 3 9 15M21 3l-7 18-5-6-6-5 18-7Z" />
              </svg>
            </button>
          </form>
          {!urgentShown && !privatePanel?.urgent && (
            <p
              className="cedar-assistant-footer"
              lang={footerLanguage}
              dir={footerLanguage === "ar" ? "rtl" : "ltr"}
            >
              {emergencyLine[footerLanguage]}
            </p>
          )}
        </aside>
      )}
    </>
  );
}
