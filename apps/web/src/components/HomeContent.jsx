import Icon from "./Icon.jsx";
import ProfessionalAvatar from "./ProfessionalAvatar.jsx";
import Reveal from "./Reveal.jsx";
import SpecialtyIcon from "./SpecialtyIcon.jsx";
import { services } from "../data/homeContent.js";
import { specialtyLabel } from "../data/specialties.js";
import { professionalName } from "../data/professionalNames.js";

export default function HomeContent({ result }) {
  const schedule =
    result.status === "success" &&
    result.schedule?.publicationStatus === "published"
      ? result.schedule
      : null;
  const seen = new Set();
  const people = (
    schedule?.centerClosed ? [] : (schedule?.doctorSessions ?? [])
  )
    .filter((session) => {
      const key = session.professionalId ?? session.doctorName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
  return (
    <>
      <section
        id="services"
        tabIndex={-1}
        className="home-services home-section"
        aria-labelledby="home-services-title"
      >
        <Reveal className="container home-services-group" watchSkipped>
          <div className="home-section-heading">
            <h2 id="home-services-title">Care at Cedar.</h2>
          </div>
          <div className="home-service-list">
            {services.map((service) => (
              <article className="home-service" key={service.slug}>
                <Icon name={service.icon} />
                <h3>{service.title}</h3>
                <p>{service.description}</p>
                <a href={`/services/${service.slug}`}>
                  Explore{" "}
                  {service.slug === "clinic"
                    ? "clinic sessions"
                    : service.title.toLowerCase()}
                </a>
              </article>
            ))}
          </div>
        </Reveal>
      </section>
      <section
        id="doctors"
        tabIndex={-1}
        className="home-people container home-section"
        aria-labelledby="home-people-title"
      >
        <Reveal className="home-directory-group" watchSkipped>
          <div className="home-section-heading">
            <div>
              <h2 id="home-people-title">Doctors and specialists</h2>
              <p>
                Explore published doctors and specialists by name or specialty.
              </p>
              <a className="home-button" href="/doctors">
                Browse all doctors
              </a>
            </div>
          </div>
          {people.length > 0 ? (
            <div className="home-people-list">
              {people.map((person) => (
                <article
                  className="home-person"
                  key={person.professionalId ?? person.id}
                >
                  <ProfessionalAvatar avatarVariant={person.avatarVariant} />
                  <div>
                    <h3>{professionalName(person.doctorName)}</h3>
                    <p className="home-person-specialty">
                      <SpecialtyIcon specialty={person.specialty} />
                      <span>{specialtyLabel(person.specialty)}</span>
                    </p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="home-directory-state">
              {result.status === "loading"
                ? "Checking today’s published doctor sessions…"
                : result.status === "error"
                  ? "Doctor previews are unavailable right now. Try the schedule again or browse the directory."
                  : schedule?.centerClosed
                    ? "The center is closed today. Browse all doctors for published professionals."
                    : "No doctor previews are published for today. Browse all doctors or choose another day."}
            </p>
          )}
          {people.length > 0 && (
            <p className="home-small-note">
              From today’s published doctor sessions. See the schedule above for
              session status.
            </p>
          )}
        </Reveal>
      </section>
      <section
        id="about"
        tabIndex={-1}
        className="container home-about home-section"
        aria-labelledby="home-about-title"
      >
        <div>
          <h2 id="home-about-title">
            Clear information.
            <br />A simpler next step.
          </h2>
          <p className="home-lead">
            Plan your visit with published clinic sessions and service hours in
            one place.
          </p>
          <p className="home-about-story">
            We imagine a center where finding care feels simple. A friendly
            welcome, clear information, and a team that helps you find your way.
          </p>
          <p className="home-small-note">
            Provisional center story. Branding and center details remain subject
            to confirmation.
          </p>
        </div>
        <Reveal className="home-request-group" watchSkipped>
          <div className="home-request-explanation">
            <h3>Before you make a request</h3>
            <ol className="home-request-steps">
              <li>
                <strong>Choose a clinic session</strong>
              </li>
              <li>
                <strong>Send your request</strong>
              </li>
              <li>
                <strong>Reception reviews it</strong>
                <span>
                  Your request needs confirmation. No appointment is reserved by
                  choosing a session.
                </span>
              </li>
            </ol>
            <a className="home-link" href="/schedule">
              Explore clinic sessions
            </a>
          </div>
        </Reveal>
      </section>
      <section
        id="contact"
        tabIndex={-1}
        className="home-contact home-section"
        aria-labelledby="home-contact-title"
      >
        <div className="container home-contact-grid">
          <div>
            <h2 id="home-contact-title">Before you visit.</h2>
            <p>Contact reception for service details and directions.</p>
            <p className="home-small-note">
              The details below are fictional placeholders, not contact
              information for a real center.
            </p>
            <div className="home-contact-details">
              <div>
                <Icon name="phone" />
                <div>
                  <h3>+961 (0) 00 000 000</h3>
                  <p>Synthetic phone placeholder</p>
                </div>
              </div>
              <div>
                <Icon name="pin" />
                <div>
                  <h3>Cedar Avenue, Example District</h3>
                  <p>Fictional address. Location to be confirmed.</p>
                </div>
              </div>
            </div>
          </div>
          <Reveal className="home-map-group" watchSkipped>
            <div className="location-card">
              <div className="location-pattern" aria-hidden="true">
                <div className="map-pin">
                  <Icon name="pin" />
                </div>
              </div>
              <div className="location-caption">
                <h3>Location preview</h3>
                <p>
                  Schematic illustration only, not a live map. The address is
                  fictional; a real map will follow once the center details are
                  confirmed.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
