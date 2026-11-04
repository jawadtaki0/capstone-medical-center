import Icon from "./Icon.jsx";
import SpecialtyIcon from "./SpecialtyIcon.jsx";
import { specialtyLabel } from "../data/specialties.js";
import { professionalName } from "../data/professionalNames.js";
import { timeRange } from "../lib/scheduleDate.js";
import { requestSelectionUrl } from "../request-selection.js";

// Both public session lists retain the published tuple; the request form revalidates it.
export default function PublicSessionRow({ session, label, onPreview }) {
  const eligible = session.status === "active";
  return (
    <article className="public-session-row">
      <div className="public-session-person">
        <p className="public-session-kind">{label}</p>
        <h3>{professionalName(session.doctorName ?? session.name)}</h3>
        <p className="public-session-specialty">
          <SpecialtyIcon specialty={session.specialty} />
          <span>{specialtyLabel(session.specialty)}</span>
        </p>
      </div>
      <div className="public-session-window">
        <span>
          <Icon name="clock" /> Attendance window
        </span>
        <strong>{timeRange(session.startTime, session.endTime)}</strong>
        {session.appointmentRequired && <small>Appointment required</small>}
      </div>
      <div className="public-session-action">
        {eligible ? (
          onPreview ? (
            <button
              className="button button-primary"
              type="button"
              onClick={() => onPreview("Book an appointment", session)}
            >
              Request session
            </button>
          ) : (
            <a
              className="button button-primary"
              href={requestSelectionUrl(session)}
            >
              Request session
            </a>
          )
        ) : (
          <span className="public-session-status">
            {session.status === "cancelled" ? "Cancelled" : "Unavailable"}
          </span>
        )}
      </div>
    </article>
  );
}
