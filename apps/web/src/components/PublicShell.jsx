import Header from "./Header.jsx";
import { Footer } from "./HomeSections.jsx";
import HomeBackground from "./HomeBackground.jsx";
import "./publicShell.css";

export default function PublicShell({ children, overlay, ...navigation }) {
  function skipToContent(event) {
    event.preventDefault();
    const main = document.getElementById("main");
    main?.focus({ preventScroll: true });
    main?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
  return (
    <div className="public-site">
      <a className="skip-link" href="#main" onClick={skipToContent}>
        Skip to content
      </a>
      <Header {...navigation} publicDesign />
      <main id="main" tabIndex={-1} className="public-canvas">
        <HomeBackground />
        <div className="public-page-content">{children}</div>
      </main>
      <Footer
        publicDesign
        patientAccounts={Boolean(navigation.patientAccountLink)}
      />
      {overlay}
    </div>
  );
}
