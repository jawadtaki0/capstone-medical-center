import { useEffect, useId, useRef, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { isAccessError } from "../lib/staffManagement.js";
import AssistantBooking from "./AssistantBooking.jsx";
import AssistantChange from "./AssistantChange.jsx";
import AssistantLab from "./AssistantLab.jsx";
import AssistantPrepare from "./AssistantPrepare.jsx";
import { TEXT } from "./assistantText.js";
import "./assistant.css";

const SCREEN = {
  en: "Open this screen",
  ar: "فتح هذه الصفحة",
};

const TASKS = {
  book: AssistantBooking,
  cancel: AssistantChange,
  reschedule: AssistantChange,
  labCreate: AssistantLab,
  collect: AssistantLab,
  labCancel: AssistantLab,
  release: AssistantLab,
  labPrepare: AssistantPrepare,
};

// A form opens straight away when the question carried details, else on request.
function Task({ api, language, task, question, roles, onError, onDone }) {
  const [open, setOpen] = useState(task.open);
  const Card = TASKS[task.type];
  return open ? (
    <Card
      api={api}
      type={task.type}
      language={language}
      prefill={task.prefill}
      today={task.today}
      question={question ?? ""}
      roles={roles}
      onError={onError}
      onDone={onDone}
    />
  ) : (
    <div className="staff-actions assistant-actions">
      <button
        type="button"
        className="staff-button staff-button-primary"
        onClick={() => setOpen(true)}
      >
        {TEXT[language].start}
      </button>
    </div>
  );
}

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

export default function AssistantPanel({
  api,
  lab,
  roles,
  onError,
  onNavigate,
}) {
  const id = useId(),
    generation = useRef(0),
    pending = useRef(false),
    end = useRef(null),
    language = useRef("en"),
    chat = useRef(null);
  const [turns, setTurns] = useState([]),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [chats, setChats] = useState([]),
    [removing, setRemoving] = useState(null);

  async function recent() {
    try {
      setChats((await api.assistantChats()).chats);
    } catch (e) {
      if (isAccessError(e)) onError?.(e);
    }
  }
  async function ask(request, shown) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const n = ++generation.current;
    try {
      // Only the current question is sent; earlier turns stay on screen.
      // The greeting is not a conversation, so it is not saved.
      const reply = await api.assistantMessage({
        ...request,
        lab,
        ...(shown === null ? {} : { chatId: chat.current }),
      });
      if (n !== generation.current) return;
      language.current = reply.language;
      setTurns((all) => [
        ...all,
        { id: crypto.randomUUID(), question: shown, reply },
      ]);
      setText("");
      if (shown !== null) recent();
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
    chat.current = crypto.randomUUID();
    setRemoving(null);
    setTurns([]);
    setText("");
    setError("");
    setBusy(false);
    ask({ topic: "capabilities", language: "en" }, null);
  }
  // Saved turns are shown as they were. Forms stay closed until asked for.
  async function reopen(id) {
    if (pending.current) return;
    setError("");
    const n = ++generation.current;
    try {
      const saved = await api.assistantChat({ id });
      if (n !== generation.current) return;
      chat.current = saved.id;
      language.current = saved.turns.at(-1)?.reply.language ?? "en";
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Beirut",
      }).format(new Date());
      setTurns(
        saved.turns.map(({ id: turnId, question, reply, outcome }) => ({
          id: turnId,
          question,
          outcome,
          reply: {
            ...reply,
            turnId,
            ...(reply.task
              ? { task: { ...reply.task, today, open: false } }
              : {}),
          },
        })),
      );
    } catch (e) {
      if (n === generation.current) setError(e.message);
      if (isAccessError(e)) onError?.(e);
    }
  }
  async function remove(id) {
    try {
      await api.assistantDelete({ id });
      setRemoving(null);
      if (chat.current === id) start();
      await recent();
    } catch (e) {
      setError(e.message);
      if (isAccessError(e)) onError?.(e);
    }
  }
  useEffect(() => {
    recent();
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
      {chats.length > 0 && (
        <details className="staff-state assistant-recent">
          <summary>Recent chats ({chats.length})</summary>
          <p className="staff-help">
            Only you can see these. They are removed after 30 days.
          </p>
          <ul>
            {chats.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="staff-button staff-button-link"
                  disabled={busy}
                  onClick={() => reopen(c.id)}
                >
                  <bdi>{c.title}</bdi>
                </button>
                <span className="staff-help">
                  {new Date(c.updatedAt).toLocaleDateString("en-GB", {
                    timeZone: "Asia/Beirut",
                  })}
                </span>
                {removing === c.id ? (
                  <button
                    type="button"
                    className="staff-button staff-button-danger"
                    onClick={() => remove(c.id)}
                  >
                    Confirm delete
                  </button>
                ) : (
                  <button
                    type="button"
                    className="staff-button"
                    onClick={() => setRemoving(c.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="assistant-turns" role="log" aria-live="polite">
        {turns.map(({ id: turnId, question, reply, outcome }) => {
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
                {reply.stale && (
                  <p className="staff-help">{TEXT[reply.language].stale}</p>
                )}
                {outcome && (
                  <p className="staff-notice assistant-done">{outcome}</p>
                )}
                {reply.task && !outcome && (
                  <Task
                    api={api}
                    language={reply.language}
                    task={reply.task}
                    question={question}
                    roles={roles}
                    onError={onError}
                    onDone={(message) => {
                      if (reply.turnId)
                        api
                          .assistantOutcome({
                            id: chat.current,
                            turnId: reply.turnId,
                            outcome: message,
                          })
                          .catch(() => {});
                    }}
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
