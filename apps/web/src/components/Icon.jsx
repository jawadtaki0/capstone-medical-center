const paths = {
  arrow: "M5 12h14m-5-5 5 5-5 5",
  chevron: "m6 9 6 6 6-6",
  clock: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  pin: "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  phone:
    "m7 3 3 5-3 3c2 3 3 4 6 6l3-3 5 3c-1 5-5 5-9 3C6 17 2 11 3 6c0-2 2-3 4-3Z",
  heart: "M20 5c-3-3-6-1-8 1-2-2-5-4-8-1-5 5 2 11 8 16 6-5 13-11 8-16Z",
  lab: "M9 3h6m-5 0v7L4 20h16l-6-10V3M7 15h10",
  people:
    "M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 9v-2a6 6 0 0 1 12 0v2m1-14a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5",
  calendar: "M4 5h16v16H4ZM8 2v6m8-6v6M4 11h16m-12 4h2m4 0h2",
};
export default function Icon({ name }) {
  return (
    <svg
      className="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.arrow} />
    </svg>
  );
}
export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Cedar Medical Center home">
      <span className="brand-mark" aria-hidden="true">
        +
      </span>
      <span>
        Cedar<span className="brand-subtitle">MEDICAL CENTER</span>
      </span>
    </a>
  );
}
