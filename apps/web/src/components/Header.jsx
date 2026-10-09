import { useEffect, useRef, useState } from "react";
import Icon, { Brand } from "./Icon.jsx";

const mobileQuery = "(max-width: 1179px)";

export default function Header({
  onPreview,
  onSchedulePage = false,
  onDoctorsPage = false,
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia(mobileQuery).matches,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [centerOpen, setCenterOpen] = useState(false);
  const header = useRef(null);
  const menuButton = useRef(null);
  const centerButton = useRef(null);
  const onHomePage = !onSchedulePage && !onDoctorsPage;
  const homeLink = onHomePage ? "#main" : "/";
  const homeSectionLink = (id) => (onHomePage ? `#${id}` : `/#${id}`);

  function closeNavigation() {
    setMenuOpen(false);
    setCenterOpen(false);
  }

  useEffect(() => {
    const query = window.matchMedia(mobileQuery);
    function onBreakpoint() {
      setMobile(query.matches);
      closeNavigation();
    }
    function onOutside(event) {
      if (!header.current?.contains(event.target)) closeNavigation();
    }
    query.addEventListener("change", onBreakpoint);
    document.addEventListener("pointerdown", onOutside);
    return () => {
      query.removeEventListener("change", onBreakpoint);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, []);

  useEffect(() => {
    if (!mobile || !menuOpen) return;
    const prior = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = prior;
    };
  }, [mobile, menuOpen]);

  function onHeaderKeyDown(event) {
    if (event.key === "Tab" && mobile && menuOpen) {
      const controls = [...header.current.querySelectorAll("a, button")].filter(
        (control) =>
          control.getClientRects().length && !control.closest("[inert]"),
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    if (centerOpen && !mobile) {
      setCenterOpen(false);
      centerButton.current?.focus();
    } else if (menuOpen) {
      closeNavigation();
      menuButton.current?.focus();
    }
  }

  function goTo(id) {
    closeNavigation();
    if (mobile && onHomePage && id)
      requestAnimationFrame(() =>
        document.getElementById(id)?.focus({ preventScroll: true }),
      );
  }

  function preview(action) {
    // The mobile action becomes inert as its panel closes; keep focus return stable.
    if (mobile) menuButton.current?.focus();
    closeNavigation();
    onPreview(action);
  }

  return (
    <header ref={header} onKeyDown={onHeaderKeyDown}>
      <div className="contact-strip">
        <div className="container contact-strip-inner">
          <span>
            <Icon name="phone" /> +961 (0) 00 000 000{" "}
            <small>· Sample number</small>
          </span>
          <span>
            <Icon name="pin" /> Cedar Avenue, Example District{" "}
            <small>· Fictional location</small>
          </span>
          <span className="strip-note">Here for you, every step.</span>
        </div>
      </div>
      <div className="container header-inner">
        <Brand />
        <button
          ref={menuButton}
          className={`menu-toggle ${menuOpen ? "is-open" : ""}`}
          type="button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          onClick={() => {
            setMenuOpen(!menuOpen);
            setCenterOpen(false);
          }}
        >
          <span className="menu-toggle-lines" aria-hidden="true">
            <span />
            <span />
          </span>
        </button>
        <div
          className={`mobile-menu-layers ${menuOpen ? "is-open" : ""}`}
          aria-hidden="true"
        >
          <span />
          <span />
        </div>
        <nav
          id="main-navigation"
          className={`main-nav ${menuOpen ? "is-open" : ""}`}
          aria-label="Main navigation"
          inert={mobile && !menuOpen ? true : undefined}
        >
          <a
            className="nav-pill"
            href={homeLink}
            aria-current={onHomePage ? "page" : undefined}
            onClick={() => goTo("main")}
          >
            <span>Home</span>
          </a>
          <div
            className="nav-disclosure"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setCenterOpen(false);
            }}
          >
            <button
              ref={centerButton}
              className="nav-pill center-toggle"
              data-active={onDoctorsPage || undefined}
              type="button"
              aria-expanded={centerOpen}
              aria-controls="center-links"
              onClick={() => setCenterOpen(!centerOpen)}
            >
              <span>
                Our Center <Icon name="chevron" />
              </span>
            </button>
            <span className="mobile-center-label">Our Center</span>
            <div
              id="center-links"
              className="dropdown"
              hidden={!mobile && !centerOpen}
            >
              <a href={homeSectionLink("about")} onClick={() => goTo("about")}>
                About Us
              </a>
              <a
                href="/doctors"
                aria-current={onDoctorsPage ? "page" : undefined}
                onClick={() => goTo()}
              >
                Our Doctors
              </a>
            </div>
          </div>
          <a
            className="nav-pill"
            href={homeSectionLink("services")}
            onClick={() => goTo("services")}
          >
            <span>Services</span>
          </a>
          <button
            className="nav-pill"
            type="button"
            onClick={() => preview("Laboratory")}
          >
            <span>Laboratory</span>
          </button>
          <a
            className="nav-pill"
            href="/schedule"
            aria-current={onSchedulePage ? "page" : undefined}
            onClick={() => goTo()}
          >
            <span>Schedule</span>
          </a>
          <a
            className="nav-pill"
            href={homeSectionLink("contact")}
            onClick={() => goTo("contact")}
          >
            <span>Contact</span>
          </a>
          <button
            className="nav-pill login-link"
            type="button"
            onClick={() => preview("Patient login")}
          >
            <span>Patient login</span>
          </button>
          <button
            className="button button-primary header-cta"
            type="button"
            onClick={() => preview("Book an appointment")}
          >
            Book an appointment <Icon name="arrow" />
          </button>
        </nav>
      </div>
    </header>
  );
}
