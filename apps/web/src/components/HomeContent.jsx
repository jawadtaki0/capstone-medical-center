import { longDate, timeRange } from "../lib/scheduleDate.js";
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
            <h2 id="home-contact-title">Visit Cedar Medical Center</h2>
            <p>
              Find us in Bourj El Brajneh, near Noureddine Bookshop. Contact
              reception for service details.
            </p>
            <div className="home-contact-details">
              <div>
                <Icon name="pin" />
                <div>
                  <h3>Address</h3>
                  <p>
                    Bourj El Brajneh, near Noureddine Bookshop
                    <br />
                    Beirut
                  </p>
                </div>
              </div>
              <div>
                <Icon name="phone" />
                <div>
                  <h3>Phone</h3>
                  <p>
                    <bdi dir="ltr">+961 81 814 554</bdi>
                  </p>
                </div>
              </div>
              <div>
                <Icon name="clock" />
                <div>
                  <h3>Center opening hours</h3>
                  {schedule ? (
                    <>
                      <p>
                        {longDate(schedule.date)}
                        <br />
                        {schedule.centerClosed
                          ? "The center is closed on this day."
                          : schedule.centerHours
                            ? timeRange(
                                schedule.centerHours.startTime,
                                schedule.centerHours.endTime,
                              )
                            : "Center opening hours are not listed."}
                      </p>
                    </>
                  ) : (
                    <p>
                      {result.status === "loading"
                        ? "Loading published center hours…"
                        : result.status === "error"
                          ? "Center hours couldn’t be loaded. Please check the full schedule again."
                          : "Center hours are not published yet."}
                    </p>
                  )}
                  <a className="home-map-link" href="/schedule">
                    View full schedule
                  </a>
                </div>
              </div>
            </div>
            <div className="home-actions">
              <a className="home-button" href="tel:+96181814554">
                Call
              </a>
              <a
                className="home-button"
                href="https://wa.me/96181814554"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="WhatsApp reception (opens in a new tab)"
              >
                WhatsApp
              </a>
            </div>
          </div>
          <Reveal className="home-map-group" watchSkipped>
            <div className="location-card">
              <iframe
                className="home-location-map"
                width="600"
                height="380"
                title="Cedar Medical Center location on OpenStreetMap"
                src="https://www.openstreetmap.org/export/embed.html?bbox=35.5043517%2C33.8374762%2C35.5091517%2C33.8404762&layer=mapnik&marker=33.8389762%2C35.5067517"
                loading="lazy"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
              <div className="location-caption">
                <a
                  className="home-map-link"
                  href="https://maps.app.goo.gl/vnkpWvwB95EadX7L8"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Get directions on Google Maps (opens in a new tab)"
                >
                  Get directions <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
