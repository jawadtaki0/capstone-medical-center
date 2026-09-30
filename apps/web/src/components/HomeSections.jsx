import Icon, { Brand } from "./Icon.jsx";
import Reveal from "./Reveal.jsx";
import SpecialtyIcon from "./SpecialtyIcon.jsx";
import { specialtyLabel } from "../data/specialties.js";
import { services } from "../data/homeContent.js";
import { longDate, timeRange } from "../lib/scheduleDate.js";
import "./homeDoctors.css";

export function VisitInfo({ result }) {
  const schedule = result.schedule;
  let hours = "Checking today’s opening hours…";
  if (result.status === "error") hours = "Opening hours could not be loaded.";
  if (schedule?.publicationStatus === "unpublished") hours = "Today’s schedule is not available yet.";
  if (schedule?.centerClosed) hours = "Closed today.";
  if (schedule?.centerHours) hours = `Open today: ${timeRange(schedule.centerHours.startTime, schedule.centerHours.endTime)}`;
  return (
    <div className="visit-info">
      <div className="container visit-info-inner">
        <div className="info-item">
          <span className="icon-tile"><Icon name="clock" /></span>
          <div>
            <strong>A little planning, a smoother visit.</strong>
            <p>{hours}</p>
          </div>
        </div>
        <a className="info-shortcut" href="#doctors">
          <span>Who’s here today?<small>View today’s doctor sessions</small></span>
          <Icon name="arrow" />
        </a>
      </div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, children }) {
  return (
    <div className="section-heading">
      <Reveal><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></Reveal>
      {children}
    </div>
  );
}

function doctorInitials(name) {
  return name.replace(/^Dr\.?\s*/i, "").split(/\s+/).slice(0, 2)
    .map((part) => part[0] ?? "").join("").toUpperCase();
}

function SessionAction({ session, onPreview }) {
  if (session.status !== "active") {
    return <span className="home-doctor-status">
      {session.status === "cancelled" ? "Cancelled" : "Unavailable"}
    </span>;
  }
  return <button className="text-button" type="button" onClick={() => onPreview("Book appointment (prototype)")}>
    Book appointment (prototype) <Icon name="arrow" />
  </button>;
}

export function Doctors({ onPreview, result, onRetry }) {
  const sessions = result.schedule?.doctorSessions ?? [];
  const featured = sessions.find((session) => session.status === "active") ?? sessions[0];
  const supporting = sessions.filter((session) => session !== featured);
  const hasActiveSession = sessions.some((session) => session.status === "active");
  const supportingTones = ["avatar-warm", "avatar-teal", "avatar-blue"];

  return <section id="doctors" tabIndex={-1} className="section container" aria-labelledby="doctors-title">
    <SectionHeading eyebrow="PEOPLE AT THE HEART OF YOUR CARE" title={<span id="doctors-title">Today’s doctors</span>}>
      <p className="section-note">
        {result.schedule ? `Doctor sessions for ${longDate(result.schedule.date)}.` : "Checking today’s doctor sessions."}
      </p>
    </SectionHeading>

    {result.status === "loading" && <div className="home-doctor-state" role="status">
      <h3>Checking today’s schedule…</h3><p>Doctor sessions will appear here shortly.</p>
    </div>}
    {result.status === "error" && <div className="home-doctor-state" role="alert">
      <h3>Today’s doctors are unavailable right now.</h3>
      <p>We couldn’t load the schedule. Please try again.</p>
      <button className="text-button" type="button" onClick={onRetry}>
        Try again <Icon name="arrow" />
      </button>
    </div>}
    {result.status === "success" && result.schedule?.publicationStatus === "unpublished" && <div className="home-doctor-state">
      <h3>Today’s schedule is not available yet.</h3>
      <p>Please check again later or view another day.</p>
      <a className="text-button" href="/schedule">View the full schedule <Icon name="arrow" /></a>
    </div>}
    {result.status === "success" && result.schedule?.publicationStatus === "published" && sessions.length === 0 && <div className="home-doctor-state">
      <h3>{result.schedule.centerClosed ? "The center is closed today." : "No doctor sessions today."}</h3>
      <p>Choose another day to see doctor sessions and service hours.</p>
      <a className="text-button" href="/schedule">View the full schedule <Icon name="arrow" /></a>
    </div>}

    {result.status === "success" && featured && <>
      <div className={`doctors-layout ${supporting.length === 0 ? "home-doctors-single" : ""}`}>
        <Reveal className="card-reveal" direction="left" key={featured.id}>
          <article className="doctor-feature">
            <div className="feature-copy">
              <p className="card-kicker">FEATURED DOCTOR</p>
              <h3>{featured.doctorName}</h3>
              <p className="feature-specialty specialty-line"><SpecialtyIcon specialty={featured.specialty} /><span className="specialty-label">{specialtyLabel(featured.specialty)}</span></p>
              <p className="feature-intro">Today’s session at Cedar Medical Center.</p>
              <p className="session-time"><Icon name="clock" /> {timeRange(featured.startTime, featured.endTime)}</p>
              {featured.appointmentRequired && <p className="card-description">Appointment required.</p>}
              <SessionAction session={featured} onPreview={onPreview} />
            </div>
            <div className="feature-portrait" aria-label={`Illustrated initials for ${featured.doctorName}; no photograph supplied`} role="img">
              <span className="feature-monogram">{doctorInitials(featured.doctorName)}</span>
              <span className="feature-cross" aria-hidden="true">+</span>
            </div>
          </article>
        </Reveal>
        {supporting.length > 0 && <div className="supporting-doctors home-supporting-doctors">
          {supporting.map((doctor, index) => <Reveal className="card-reveal" direction="right" delay={(index + 1) * 70} key={doctor.id}>
            <article className="doctor-card">
              <div className={`doctor-avatar ${supportingTones[index % supportingTones.length]}`} aria-hidden="true">
                {doctorInitials(doctor.doctorName)}<span>+</span>
              </div>
              <div className="doctor-details">
                <p className="card-kicker specialty-line"><SpecialtyIcon specialty={doctor.specialty} /><span className="specialty-label">{specialtyLabel(doctor.specialty)}</span></p>
                <h3>{doctor.doctorName}</h3>
                <p className="session-time"><Icon name="clock" /> {timeRange(doctor.startTime, doctor.endTime)}</p>
                {doctor.appointmentRequired && <p className="card-description">Appointment required.</p>}
                <SessionAction session={doctor} onPreview={onPreview} />
              </div>
            </article>
          </Reveal>)}
        </div>}
      </div>
      {hasActiveSession && <p className="section-caption">Booking buttons are prototype actions; no appointment is reserved.</p>}
    </>}
  </section>;
}

export function Services({ onPreview }) {
  return (
    <section id="services" tabIndex={-1} className="services-section section" aria-labelledby="services-title">
      <div className="container">
        <SectionHeading eyebrow="SUPPORT FOR EVERYDAY HEALTH" title={<span id="services-title">Care, all in one place.</span>}>
          <p className="section-note">A few ways our fictional center <br />could support you and your family.</p>
        </SectionHeading>
        <div className="service-grid">
          {services.map((service, index) => (
            <Reveal className="card-reveal" direction={index === 2 ? "right" : "left"} delay={index * 70} key={service.title}>
              <article className="service-card">
                <span className="service-number">0{index + 1}</span>
                <span className="icon-tile"><Icon name={service.icon} /></span>
                <h3>{service.title}</h3>
                <p>{service.description}</p>
                <button className="text-button" onClick={() => onPreview(service.title)}>
                  Explore service <Icon name="arrow" />
                </button>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function About() {
  return (
    <section id="about" tabIndex={-1} className="section container" aria-labelledby="about-title">
      <div className="about-grid">
        <div className="about-panel">
          <span className="about-cross" aria-hidden="true">+</span>
          <p className="eyebrow">A PLACE TO FEEL AT EASE</p>
          <p className="about-statement">Good care starts<br />with feeling<br /><em>welcome.</em></p>
          <span className="sample-caption">Provisional center story</span>
        </div>
        <div className="about-copy">
          <Reveal><p className="eyebrow">ABOUT OUR CENTER</p><h2 id="about-title">Your neighborhood.<br />Your care team.</h2></Reveal>
          <p>We imagine a center where finding care feels simple. A friendly welcome, clear information, and a team that helps you find your way.</p>
          <p>From a routine visit to a laboratory follow-up, our goal is to make each step feel a little more personal.</p>
          <a className="text-button" href="#contact">Get to know your way here <Icon name="arrow" /></a>
        </div>
      </div>
    </section>
  );
}

export function Contact() {
  return (
    <section id="contact" tabIndex={-1} className="contact-section section" aria-labelledby="contact-title">
      <div className="container contact-grid">
        <div>
          <Reveal><p className="eyebrow">LET’S MAKE YOUR VISIT EASIER</p><h2 id="contact-title">We’re here to help.</h2></Reveal>
          <p className="contact-intro">A question before your visit? Our reception team would be your first point of contact.</p>
          <div className="contact-detail">
            <Icon name="phone" />
            <div><strong>+961 (0) 00 000 000</strong><p>Synthetic phone placeholder</p></div>
          </div>
          <div className="contact-detail">
            <Icon name="pin" />
            <div><strong>Cedar Avenue, Example District</strong><p>Fictional address · location to be confirmed</p></div>
          </div>
        </div>
        <div className="location-card">
          <div className="location-pattern" aria-hidden="true"><div className="map-pin"><Icon name="pin" /></div></div>
          <div className="location-caption">
            <strong>A familiar place, close to home.</strong>
            <p>Location preview — a real map will follow once the center details are confirmed.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-top">
          <Brand /><p>Thoughtful care, closer to you.</p><a className="text-button" href="#main">Back to top ↑</a>
        </div>
        <div className="footer-bottom">
          <p>© 2026 Cedar Medical Center · Prototype branding</p>
          <p>Branding and contact details are provisional. Booking buttons are prototypes; sign-in is not available yet.</p>
        </div>
      </div>
    </footer>
  );
}
