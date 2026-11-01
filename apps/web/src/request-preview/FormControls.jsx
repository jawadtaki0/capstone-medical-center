import { useEffect, useId, useRef, useState } from "react";
import {
  PHONE_COUNTRIES,
  callingCode,
  countryFlag,
  phoneExample,
  phoneNumber,
  canonicalPhone,
  formattedPhoneInput,
} from "../../../staff/shared/contact-input.js";
import ProfessionalAvatar from "../components/ProfessionalAvatar.jsx";
import { calendarYear } from "../request-selection.js";

export function PreviewDialog({ title, onClose, children }) {
  const ref = useRef(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current,
      opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="request-dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ].filter((node) => node.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (
          (e.shiftKey && document.activeElement === first) ||
          (!e.shiftKey && document.activeElement === last)
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="request-dialog-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <button
          type="button"
          className="request-icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function DateField({
  label,
  value,
  onChange,
  dob = false,
  language = "en",
  error,
}) {
  const id = useId(),
    [open, setOpen] = useState(false);
  return (
    <div className="request-field">
      <label htmlFor={id}>{label}</label>
      <div className="request-date-entry" dir="ltr">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          placeholder="YYYY-MM-DD"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={10}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          autoComplete={dob ? "bday" : "off"}
        />
        <button
          type="button"
          aria-label={`${language === "ar" ? "افتح التقويم" : "Open calendar"}: ${label}`}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <svg
            viewBox="0 0 24 24"
            width="21"
            height="21"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <rect x="3" y="5" width="18" height="16" rx="3" />
            <path d="M7 3v5m10-5v5M3 11h18" />
          </svg>
        </button>
      </div>
      {error ? (
        <p className="request-error" id={`${id}-error`}>
          {error}
        </p>
      ) : (
        <small id={`${id}-hint`}>
          {language === "ar"
            ? "أدخل السنة-الشهر-اليوم أو اختر من التقويم."
            : "Type year-month-day or use the calendar."}
        </small>
      )}
      {open && (
        <Calendar
          value={value}
          dob={dob}
          language={language}
          title={label}
          onClose={() => setOpen(false)}
          onChoose={(date) => {
            onChange(date);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
function Calendar({ value, dob, language, title, onChoose, onClose }) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : dob
      ? "2000-01-01"
      : new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Beirut",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
  const [month, setMonth] = useState(Number(start.slice(5, 7)) - 1),
    [year, setYear] = useState(Number(start.slice(0, 4))),
    [yearDraft, setYearDraft] = useState(start.slice(0, 4)),
    [yearError, setYearError] = useState(false),
    [focus, setFocus] = useState(Number(start.slice(8)) || 1);
  const id = useId(),
    locale = language === "ar" ? "ar-LB" : "en-GB",
    pad = (n) => String(n).padStart(2, "0"),
    dateFor = (day) => `${year}-${pad(month + 1)}-${pad(day)}`;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
    offset = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const monthName = (m) =>
    new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2000, m, 1)),
    );
  const label =
    language === "ar"
      ? {
          month: "الشهر",
          year: "السنة",
          previous: "الشهر السابق",
          next: "الشهر التالي",
          cancel: "إلغاء",
        }
      : {
          month: "Month",
          year: "Year",
          previous: "Previous month",
          next: "Next month",
          cancel: "Cancel",
        };
  function shift(delta) {
    const committed =
      calendarYear(
        yearDraft,
        dob
          ? Number(
              new Intl.DateTimeFormat("en", {
                year: "numeric",
                timeZone: "Asia/Beirut",
              }).format(new Date()),
            )
          : 9999,
      ) ?? year;
    const d = new Date(Date.UTC(committed, month + delta, 1));
    if (d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 9999) return;
    setYear(d.getUTCFullYear());
    setYearDraft(String(d.getUTCFullYear()));
    setYearError(false);
    setMonth(d.getUTCMonth());
    setFocus(1);
  }
  function commitYear() {
    const next = calendarYear(
      yearDraft,
      dob
        ? Number(
            new Intl.DateTimeFormat("en", {
              year: "numeric",
              timeZone: "Asia/Beirut",
            }).format(new Date()),
          )
        : 9999,
    );
    setYearError(next === null);
    if (next !== null) {
      setYear(next);
      setFocus(1);
    }
  }
  function key(e, day) {
    let target;
    if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key))
      target =
        day +
        {
          ArrowRight: language === "ar" ? -1 : 1,
          ArrowLeft: language === "ar" ? 1 : -1,
          ArrowDown: 7,
          ArrowUp: -7,
        }[e.key];
    if (e.key === "Home") target = 1;
    if (e.key === "End") target = days;
    if (target !== undefined) {
      e.preventDefault();
      target = Math.max(1, Math.min(days, target));
      setFocus(target);
      document.getElementById(`${id}-${target}`)?.focus();
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      shift(e.key === "PageUp" ? -1 : 1);
    }
  }
  const dates = Array.from(
    { length: Math.ceil((offset + days) / 7) * 7 },
    (_, i) => i - offset + 1,
  );
  return (
    <PreviewDialog title={title} onClose={onClose}>
      <div className="request-calendar" dir={language === "ar" ? "rtl" : "ltr"}>
        <div className="request-calendar-nav">
          <button
            type="button"
            aria-label={label.previous}
            onClick={() => shift(-1)}
          >
            ‹
          </button>
          <label>
            {label.month}
            <select
              aria-label={label.month}
              value={month}
              onChange={(e) => {
                commitYear();
                setMonth(Number(e.target.value));
                setFocus(1);
              }}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i}>
                  {monthName(i)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {label.year}
            <input
              aria-label={label.year}
              type="text"
              inputMode="numeric"
              enterKeyHint="done"
              maxLength={4}
              value={yearDraft}
              aria-invalid={yearError}
              aria-describedby={yearError ? `${id}-year-error` : undefined}
              onChange={(e) => {
                setYearDraft(e.target.value);
                setYearError(false);
              }}
              onBlur={commitYear}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitYear();
                  e.currentTarget.blur();
                }
              }}
            />
          </label>
          <button
            type="button"
            aria-label={label.next}
            onClick={() => shift(1)}
          >
            ›
          </button>
        </div>
        {yearError && (
          <p role="alert" id={`${id}-year-error`} className="request-error">
            {language === "ar"
              ? "أدخل سنة صحيحة من أربعة أرقام (١٩٠٠ أو أحدث، دون سنة مستقبلية لتاريخ الولادة)."
              : "Enter a valid four-digit year (1900 or later; birth year cannot be in the future)."}
          </p>
        )}
        <button
          type="button"
          className="request-text-button"
          onClick={commitYear}
        >
          {language === "ar" ? "تطبيق السنة" : "Apply year"}
        </button>
        <table role="grid" aria-label={`${monthName(month)} ${year}`}>
          <thead>
            <tr>
              {Array.from({ length: 7 }, (_, i) => (
                <th key={i} scope="col">
                  {new Intl.DateTimeFormat(locale, {
                    weekday: "short",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(2026, 10, 1 + i)))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: dates.length / 7 }, (_, row) => (
              <tr key={row}>
                {dates.slice(row * 7, row * 7 + 7).map((d, i) => (
                  <td
                    key={i}
                    role="gridcell"
                    aria-selected={value === dateFor(d)}
                  >
                    {d > 0 && d <= days && (
                      <button
                        id={`${id}-${d}`}
                        type="button"
                        tabIndex={d === focus ? 0 : -1}
                        disabled={
                          yearDraft !== String(year) ||
                          yearError ||
                          (dob &&
                            dateFor(d) >
                              new Intl.DateTimeFormat("en-CA", {
                                timeZone: "Asia/Beirut",
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                              }).format(new Date()))
                        }
                        className={value === dateFor(d) ? "is-selected" : ""}
                        aria-label={dateFor(d)}
                        onKeyDown={(e) => key(e, d)}
                        onClick={() => onChoose(dateFor(d))}
                      >
                        {d}
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="request-secondary" onClick={onClose}>
          {label.cancel}
        </button>
      </div>
    </PreviewDialog>
  );
}
export function ProfessionalCombobox({
  professionals,
  value,
  onChange,
  language = "en",
  status = "ready",
}) {
  const id = useId(),
    host = useRef(null),
    [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const chosen = professionals.find((p) => p.id === value);
  useEffect(() => {
    if (chosen) setQuery(chosen.name);
  }, [value, chosen?.name]);
  const matches = professionals.filter((p) =>
    `${p.name} ${p.specialty}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  function choose(p) {
    onChange(p.id);
    setQuery(p.name);
    host.current.querySelector("input")?.focus();
    setOpen(false);
  }
  useEffect(() => {
    const fn = (e) => {
      if (!host.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", fn);
    return () => document.removeEventListener("pointerdown", fn);
  }, []);
  return (
    <div className="request-field request-combobox" ref={host}>
      <label htmlFor={id}>
        {language === "ar" ? "الطبيب أو الأخصائي" : "Doctor or specialist"}
      </label>
      <div className="request-search-entry">
        <svg
          viewBox="0 0 24 24"
          width="21"
          height="21"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 5 5" />
        </svg>
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-activedescendant={
            open && matches[active] ? `${id}-option-${active}` : undefined
          }
          autoComplete="off"
          placeholder={
            language === "ar"
              ? "ابحث بالاسم أو الاختصاص"
              : "Search name or specialty"
          }
          value={open ? query : (chosen?.name ?? "")}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            if (value) onChange("");
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp"].includes(e.key)) {
              e.preventDefault();
              setOpen(true);
              setActive(
                Math.max(
                  0,
                  Math.min(
                    matches.length - 1,
                    active + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === "Enter" && open) {
              e.preventDefault();
              if (matches[active]) choose(matches[active]);
            }
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Tab") setOpen(false);
          }}
        />
        <button
          type="button"
          aria-label={language === "ar" ? "مسح الاختيار" : "Clear professional"}
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(true);
            host.current.querySelector("input").focus();
          }}
        >
          ×
        </button>
      </div>
      {open && (
        <ul id={`${id}-options`} role="listbox" className="request-options">
          {(status === "ready" ? matches : []).map((p, i) => (
            <li
              key={p.id}
              id={`${id}-option-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(p)}
            >
              <ProfessionalAvatar avatarVariant={p.gender} />
              <span>
                <strong>{p.name}</strong>
                <small>{p.specialty}</small>
              </span>
            </li>
          ))}
          {status !== "ready" && (
            <li role="presentation">
              {status === "loading"
                ? language === "ar"
                  ? "جارٍ تحميل الأطباء…"
                  : "Loading professionals…"
                : language === "ar"
                  ? "تعذر تحميل الأطباء. أعد المحاولة."
                  : "Professionals unavailable. Retry loading."}
            </li>
          )}
          {status === "ready" && matches.length === 0 && (
            <li role="presentation">
              {language === "ar"
                ? "لا نتائج مطابقة"
                : "No matching professionals"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
export function RequestPhone({ value, onChange, language = "en", error }) {
  const id = useId(),
    initial = phoneNumber(value || "", "LB"),
    [country, setCountry] = useState(initial?.country ?? "LB"),
    [national, setNational] = useState(initial?.formatNational() ?? "");
  const names = new Intl.DisplayNames([language], { type: "region" });
  return (
    <div className="request-phone">
      <div className="request-field">
        <label htmlFor={`${id}-country`}>
          {language === "ar" ? "بلد الهاتف" : "Phone country"}
        </label>
        <select
          id={`${id}-country`}
          value={country}
          onChange={(e) => {
            setCountry(e.target.value);
            setNational("");
            onChange("");
          }}
        >
          {[...PHONE_COUNTRIES]
            .sort((a, b) => names.of(a).localeCompare(names.of(b)))
            .map((code) => (
              <option key={code} value={code}>
                {countryFlag(code)} {names.of(code)} +{callingCode(code)}
              </option>
            ))}
        </select>
      </div>
      <div className="request-field">
        <label htmlFor={`${id}-number`}>
          {language === "ar" ? "رقم الهاتف" : "Phone number"}
        </label>
        <div className="request-phone-entry" dir="ltr">
          <span>+{callingCode(country)}</span>
          <input
            id={`${id}-number`}
            type="tel"
            inputMode="tel"
            dir="ltr"
            value={national}
            placeholder={phoneExample(country)}
            maxLength={80}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help`}
            onChange={(e) => {
              const raw = e.target.value,
                p = phoneNumber(raw, country),
                international = /^\s*(\+|00)/.test(raw),
                next = international && p?.country ? p.country : country;
              setCountry(next);
              setNational(
                international && p
                  ? p.formatNational()
                  : formattedPhoneInput(raw, next),
              );
              onChange(canonicalPhone(raw, next) ?? "");
            }}
          />
        </div>
        <small id={`${id}-help`}>
          {error ||
            (language === "ar"
              ? "يمكن لأفراد العائلة استخدام الرقم نفسه. التنسيق ليس إثباتًا للملكية أو لتوفر واتساب."
              : "Family members may share a number. Formatting does not prove ownership or WhatsApp availability.")}
        </small>
      </div>
    </div>
  );
}
