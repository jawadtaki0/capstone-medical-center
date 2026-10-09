import SpecialtyIcon from "./SpecialtyIcon.jsx";
import ProfessionalAvatar from "./ProfessionalAvatar.jsx";
import { specialtyLabel } from "../data/specialties.js";
import { professionalName } from "../data/professionalNames.js";
import "./doctorDirectory.css";

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
          </div>
        </div>
      </div>
    </article>
  );
}
