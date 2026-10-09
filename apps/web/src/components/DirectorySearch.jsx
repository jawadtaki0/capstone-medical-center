import { useId, useRef } from "react";
import "./doctorDirectory.css";

export default function DirectorySearch({ query, onQueryChange, resultsId }) {
  const inputId = useId();
  const inputRef = useRef(null);
  function clearSearch() {
    onQueryChange("");
    inputRef.current?.focus();
  }
  return (
    <div
      className="directory-search"
      role="search"
      aria-label="Find doctors and specialists"
      data-filled={query.length > 0}
    >
      <span className="directory-search__icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          focusable="false"
        >
          <circle cx="10.8" cy="10.8" r="6.8" />
          <path d="m16 16 4.5 4.5" />
        </svg>
      </span>
      <input
        ref={inputRef}
        id={inputId}
        className="directory-search__input"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        aria-controls={resultsId}
        autoComplete="off"
        spellCheck={false}
      />
      <label className="directory-search__label" htmlFor={inputId}>
        Search by name or specialty
      </label>
      {query.length > 0 && (
        <button
          className="directory-search__clear"
          type="button"
          aria-label="Clear search"
          onClick={clearSearch}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}
