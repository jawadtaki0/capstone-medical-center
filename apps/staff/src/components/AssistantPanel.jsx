import { useEffect, useId, useRef, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { isAccessError } from "../lib/staffManagement.js";
import "./assistant.css";

const SCREEN = {
  en: "Open this screen",
  ar: "فتح هذه الصفحة",
};

function Sessions({ language, sessions }) {
  const places = (s) => {
    if (s.capacity === null)
      return language === "ar"
        ? "لم يحدد عدد المرضى"
        : "Patient limit: Not configured";
    return language === "ar"
      ? `${s.remaining} أماكن متبقية من ${s.capacity}`
      : `${s.remaining} remaining of ${s.capacity}`;
  };
  return (
    <ul className="assistant-sessions">
      {sessions.map((s) => (
        <li key={s.id}>
          <strong dir="auto">{s.professionalName}</strong>
          <span dir="ltr">
            {s.startTime}–{s.endTime}
          </span>
          <span dir="auto">{s.clinicName}</span>
          <span>{places(s)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function AssistantPanel({ api, lab, onError, onNavigate }) {
  const id = useId(),
    generation = useRef(0),
    pending = useRef(false),
    end = useRef(null),
    language = useRef("en");
  const [turns, setTurns] = useState([]),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  async function ask(request, shown) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const n = ++generation.current;
    try {
      // Only the current question is sent; earlier turns stay on screen.
      const reply = await api.assistantMessage({ ...request, lab });
      if (n !== generation.current) return;
      language.current = reply.language;
      setTurns((all) => [
        ...all,
        { id: crypto.randomUUID(), question: shown, reply },
      ]);
      setText("");
    } catch (e) {
      if (n !== generation.current) return;
      setError(e.message);
      if (isAccessError(e)) onError?.(e);
    } finally {
      pending.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  function start() {
    generation.current++;
    pending.current = false;
    language.current = "en";
    setTurns([]);
    setText("");
    setError("");
    setBusy(false);
    ask({ topic: "capabilities", language: "en" }, null);
  }
  useEffect(() => {
    start();
    return () => {
      generation.current++;
      pending.current = false;
    };
  }, []);
  useEffect(() => {
    if (turns.length > 1) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  return (
    <div className="assistant-panel">
      <p className="staff-eyebrow">AI ASSISTANT</p>
      <h1 tabIndex={-1}>AI Assistant</h1>
      <p className="staff-intro">
        Ask in English or Arabic about your Cedar Staff work. It runs on this
        computer and follows your role.
      </p>
      <div className="staff-actions">
        <button
          type="button"
          className="staff-button"
          disabled={busy}
          onClick={start}
        >
          New chat
        </button>
      </div>
      <div className="assistant-turns" role="log" aria-live="polite">
        {turns.map(({ id: turnId, question, reply }) => {
          const rtl = reply.language === "ar";
          return (
            <div className="assistant-turn" key={turnId}>
              {question && (
                <p className="assistant-question" dir="auto">
                  {question}
                </p>
              )}
              <section
                className="staff-workspace-card assistant-reply"
                dir={rtl ? "rtl" : "ltr"}
                lang={reply.language}
              >
                <p>{reply.reply}</p>
                {reply.steps.length > 0 && (
                  <ol>
                    {reply.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                {reply.sessions?.length > 0 && (
                  <Sessions
                    language={reply.language}
                    sessions={reply.sessions}
                  />
                )}
                {reply.actions.length + reply.suggestions.length > 0 && (
                  <div className="staff-actions assistant-actions">
                    {reply.actions.map((action) => (
                      <button
                        key={action.view}
                        type="button"
                        className="staff-button staff-button-primary"
                        onClick={() => onNavigate({ view: action.view })}
                      >
                        {SCREEN[reply.language]}
                      </button>
                    ))}
                    {reply.suggestions.map((s) => (
                      <button
                        key={s.topic}
                        type="button"
                        className="staff-button"
                        disabled={busy}
                        onClick={() =>
                          ask(
                            { topic: s.topic, language: reply.language },
                            s.label,
                          )
                        }
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {busy && <LoadingStatus label="Checking…" />}
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="staff-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (value) ask({ text: value }, value);
        }}
      >
        <div className="staff-field">
          <label htmlFor={`${id}-question`}>Your question</label>
          <div className="staff-search-control">
            <input
              id={`${id}-question`}
              dir="auto"
              maxLength={500}
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="submit"
              className="staff-button staff-button-primary"
              disabled={busy || !text.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
