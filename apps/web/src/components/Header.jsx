import { useEffect, useRef, useState } from "react";
import Icon, { Brand } from "./Icon.jsx";

const mobileQuery = "(max-width: 1179px)";

export default function Header({
  onPreview,
  onSchedulePage = false,
  onDoctorsPage = false,
  onRequestPage = false,
  homePage,
  publicDesign = false,
  serviceSlug,
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia(mobileQuery).matches,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [centerOpen, setCenterOpen] = useState(false);
  const header = useRef(null);
  const menuButton = useRef(null);
  const centerButton = useRef(null);
  const onHomePage =
    homePage ?? (!onSchedulePage && !onDoctorsPage && !onRequestPage);
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

  function goTo(id, event) {
    if (id && !onHomePage) {
      // Only an input modality marker crosses documents, never URL/token data.
      try {
        sessionStorage.setItem(
          "cedar-home-section-input",
          event?.detail === 0 ? "keyboard" : "pointer",
        );
      } catch {
        // Navigation and keyboard controls still work when storage is disabled.
      }
    }
    closeNavigation();
    if (mobile && onHomePage && id)
      requestAnimationFrame(() =>
        document.getElementById(id)?.focus({ preventScroll: true }),
      );
  }

  function preview(action) {
    if (mobile) menuButton.current?.focus();
    closeNavigation();
    onPreview(action);
  }

  return (
    <header
      className={onHomePage || publicDesign ? "home-header" : undefined}
      ref={header}
      onKeyDown={onHeaderKeyDown}
    >
      <div className="contact-strip">
        <div className="container contact-strip-inner">
          <a href="tel:+96181814554">
            <Icon name="phone" />
            <bdi dir="ltr">+961 81 814 554</bdi>
          </a>
          <a
            href="https://maps.app.goo.gl/vnkpWvwB95EadX7L8"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Beirut, Bourj El Brajneh, near Noureddine Bookshop on Google Maps (opens in a new tab)"
          >
            <Icon name="pin" />
            Beirut, Bourj El Brajneh, near Noureddine Bookshop{" "}
            <span aria-hidden="true">↗</span>
          </a>
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
              <a
                href={homeSectionLink("about")}
                onClick={(event) => goTo("about", event)}
              >
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
            data-active={
              serviceSlug && serviceSlug !== "laboratory" ? true : undefined
            }
            onClick={(event) => goTo("services", event)}
          >
            <span>Services</span>
          </a>
          <a
            className="nav-pill"
            href="/services/laboratory"
            aria-current={serviceSlug === "laboratory" ? "page" : undefined}
            onClick={() => goTo()}
          >
            <span>Laboratory</span>
          </a>
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
            onClick={(event) => goTo("contact", event)}
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
            {onHomePage || publicDesign
              ? "Request a session"
              : "Book an appointment"}{" "}
            <Icon name="arrow" />
          </button>
        </nav>
      </div>
    </header>
  );
}
