import { getSpecialtyIcon } from "../data/specialties.js";
import "./specialtyIcon.css";

export default function SpecialtyIcon({ specialty }) {
  const icon = getSpecialtyIcon(specialty);
  return (
    <span
      className="specialty-icon"
      aria-hidden="true"
      data-specialty-icon={icon.id}
    >
      {icon.asset ? (
        <span
          className="specialty-icon-glyph"
          style={{
            "--specialty-mask": `url("${icon.asset}")`,
            "--specialty-glyph-size": `${icon.size}px`,
          }}
        />
      ) : (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="currentColor"
          focusable="false"
        >
          <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />
        </svg>
      )}
    </span>
  );
}
