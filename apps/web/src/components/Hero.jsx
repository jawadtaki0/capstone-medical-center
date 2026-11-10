import HomeSchedule from "./HomeSchedule.jsx";

export default function Hero({ onPreview, result, onRetry }) {
  return (
    <section className="home-opening" aria-labelledby="welcome-heading">
      <div className="container home-opening-grid">
        <div className="home-introduction">
          <h1 id="welcome-heading">
            Your visit
            <br />
            starts here.
          </h1>
          <p className="home-lead">
            Find your doctor. Check the session.
            <br />
            Take the next step with Cedar.
          </p>
          <div className="home-actions">
            <button
              className="home-button"
              type="button"
              onClick={() => onPreview("Book an appointment")}
            >
              Request a clinic session
            </button>
            <a className="home-link" href="/doctors">
              Find a doctor
            </a>
          </div>
          <p className="home-request-note">
            Requests are reviewed by reception.
            <br />
            Choosing a session does not reserve an appointment.
          </p>
        </div>
        <HomeSchedule result={result} onRetry={onRetry} onPreview={onPreview} />
      </div>
    </section>
  );
}
