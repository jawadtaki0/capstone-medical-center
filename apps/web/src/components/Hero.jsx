import { useState } from "react";
import Icon from "./Icon.jsx";
import SpecularButton from "./SpecularButton.jsx";
export default function Hero({ onPreview }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoEnabled =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("photo") !== "off";
  const showPhoto = photoEnabled && !photoFailed;
  return (
    <section
      className={`hero ${showPhoto ? "hero-with-photo" : "hero-fallback"}`}
      aria-labelledby="welcome-heading"
    >
      {showPhoto && (
        <img
          className="hero-photo"
          src="/__prototype/hero.png"
          alt="A clinician with a stethoscope beside a bright clinic waiting area"
          fetchPriority="high"
          onError={() => setPhotoFailed(true)}
        />
      )}
      <div className="hero-overlay" />
      {!showPhoto && (
        <div className="fallback-art" aria-hidden="true">
          <span>+</span>
          <div className="fallback-ring" />
        </div>
      )}
      <div className="container hero-inner">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="small-line" /> WELCOME TO CEDAR MEDICAL CENTER
          </p>
          <h1 id="welcome-heading">
            Care that feels
            <br />a little closer.
          </h1>
          <p className="hero-intro">
            A welcoming place for your health. Find your doctor, explore our
            services, and take your next step with confidence.
          </p>
          <div className="action-row">
            <SpecularButton onClick={() => onPreview("Book an appointment")}>
              Book an appointment <Icon name="arrow" />
            </SpecularButton>
            <a className="button button-secondary" href="#doctors">
              Today’s schedule <Icon name="calendar" />
            </a>
          </div>
          <p className="hero-footnote">
            <Icon name="heart" /> Thoughtful care. Familiar faces. One place.
          </p>
        </div>
      </div>
      <span className="prototype-label">DESIGN PREVIEW · FICTIONAL CENTER</span>
    </section>
  );
}
