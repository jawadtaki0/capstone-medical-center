import { useEffect, useRef, useState } from "react";
import "./public-assistant.css";

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
    help: "Ask about public Clinic sessions and Lab information. Keep personal details out of chat.",
    input: "Your question",
    topicsLabel: "Guided help",
    topics: {
      urgent: "Urgent help",
      private: "My results",
      cancel: "Cancel or reschedule",
      clinical: "Medical advice",
    },
    send: "Send",
    busy: "Checking…",
    reception: "Contact Reception",
    details: "See public information",
    account: "Open My account",
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
    help: "اسأل عن جلسات العيادة المنشورة ومعلومات المختبر. تجنّب كتابة معلومات شخصية.",
    input: "سؤالك",
    topicsLabel: "مساعدة حسب الموضوع",
    topics: {
      urgent: "مساعدة طارئة",
      private: "نتائجي",
      cancel: "إلغاء الموعد أو تغييره",
      clinical: "استشارة طبية",
    },
    send: "إرسال",
    busy: "جارٍ التحقق…",
    reception: "تواصل مع الاستقبال",
    details: "عرض المعلومات العامة",
    account: "افتح حسابي",
    labResults: "افتح نتائج المختبر الآمنة",
    choose: "افتح نموذج الطلب",
    source: "المصدر",
    sample: "العينة",
    failed: "المساعد غير متاح مؤقتًا. حاول مجددًا أو تواصل مع الاستقبال.",
  },
};

export default function PublicAssistant() {
  const opener = useRef(null);
  const panel = useRef(null);
  const closeButton = useRef(null);
  const history = useRef(null);
  const latestReply = useRef(null);
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const searchContext = useRef(null);
  const [language, setLanguage] = useState(
    document.documentElement.lang === "ar" ? "ar" : "en",
  );
  const [turns, setTurns] = useState([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = labels[language];
  function close() {
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
    if (!busy && turns.at(-1)?.topic && latestReply.current) {
      log.scrollTop +=
        latestReply.current.getBoundingClientRect().top -
        log.getBoundingClientRect().top;
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }, [open, turns, busy]);
  async function send(value, topic) {
    if (busy || !value) return;
    const messages = [
      ...turns.filter((turn) => !turn.topic).map((turn) => turn.question),
      value,
    ].slice(-8);
    if (!topic) setQuestion("");
    setBusy(true);
    let answer;
    try {
      const res = await fetch("/api/public-assistant", {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          messages,
          searchContext: searchContext.current,
          ...(topic ? { topic } : {}),
        }),
        signal: AbortSignal.timeout(55_000),
      });
      if (!res.ok) throw Error();
      answer = await res.json();
      if (typeof answer.text !== "string") throw Error();
      searchContext.current = answer.searchContext ?? null;
    } catch {
      searchContext.current = null;
      answer = { kind: "failure", text: copy.failed };
    }
    setTurns((current) => [...current, { question: value, answer, topic }]);
    setBusy(false);
  }

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
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="cedar-assistant-header">
            <h2 id="cedar-assistant-title">{copy.title}</h2>
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
                  {maximized ? (
                    <path d="M6 5V3h7v7h-2M3 6h7v7H3z" />
                  ) : (
                    <rect x="3" y="3" width="10" height="10" />
                  )}
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
          <label>
            Language / اللغة{" "}
            <select
              value={language}
              disabled={busy}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <p>{copy.help}</p>
          <div
            ref={history}
            className="cedar-assistant-turns"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            tabIndex={0}
            aria-label={copy.title}
          >
            {turns.map(({ question, answer }, index) => (
              <section key={index}>
                <div className="cedar-assistant-question">
                  <strong>{copy.you}</strong>
                  <p dir="auto">{question}</p>
                </div>
                <div
                  className="cedar-assistant-reply"
                  ref={index === turns.length - 1 ? latestReply : null}
                >
                  <strong>{copy.cedar}</strong>
                  <p dir="auto">{answer.text}</p>
                  <div className="cedar-assistant-cards">
                    {answer.cards?.map((card) => (
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
                              href={card.href}
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
                  {answer.page && (
                    <a href={answer.page}>
                      {answer.page === "/account#lab-results"
                        ? copy.labResults
                        : answer.kind === "private"
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
                  ].includes(answer.kind) ||
                    answer.reception) && (
                    <p>
                      <a className="cedar-assistant-reception" href="/#contact">
                        {copy.reception}{" "}
                        <span aria-hidden="true">
                          {language === "ar" ? "←" : "→"}
                        </span>
                      </a>
                    </p>
                  )}
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
          </div>
          <div
            className="cedar-assistant-chips"
            role="group"
            aria-label={copy.topicsLabel}
          >
            {Object.entries(copy.topics).map(([topic, label]) => (
              <button
                key={topic}
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => send(label, topic)}
              >
                {label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send(question.trim());
            }}
          >
            <label htmlFor="cedar-assistant-question">{copy.input}</label>
            <input
              id="cedar-assistant-question"
              value={question}
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
        </aside>
      )}
    </>
  );
}
