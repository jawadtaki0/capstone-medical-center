import SpecialtyIcon from "./SpecialtyIcon.jsx";
import ProfessionalAvatar from "./ProfessionalAvatar.jsx";
import { specialtyLabel } from "../data/specialties.js";
import { professionalName } from "../data/professionalNames.js";
import "./doctorDirectory.css";
import { requestSelectionUrl } from "../request-selection.js";

export default function ProfessionalCard({ professional }) {
  return (
    <article className="professional-card" data-profile-id={professional.id}>
      <div className="professional-card__surface">
        <div className="professional-card__content">
          <ProfessionalAvatar avatarVariant={professional.avatarVariant} />
          <div className="professional-card__details">
            <h2 className="professional-card__name">
              {professionalName(professional.name)}
            </h2>
            <div className="professional-card__specialty">
              <SpecialtyIcon specialty={professional.specialty} />
              <p className="professional-card__specialty-text">
                {specialtyLabel(professional.specialty)}
              </p>
            </div>
            {(import.meta.env.VITE_HOSTED_REVIEW === "1" ||
              import.meta.env.VITE_HOSTED_CAPSTONE === "1" ||
              import.meta.env.VITE_WEBSITE_REQUESTS === "1") && (
              <a
                className="text-button"
                href={requestSelectionUrl(professional)}
              >
                Request a clinic session
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
