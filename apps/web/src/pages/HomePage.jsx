import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Hero from "../components/Hero.jsx";
import HomeContent from "../components/HomeContent.jsx";
import useSchedule from "../hooks/useSchedule.js";
import { isHomepageDemo } from "../homepage-preview.js";
import "./homepage.css";

// Native fragment navigation runs before this client-rendered page exists.
// Re-align only homepage section IDs after mount and known data/font layout changes.
function useHomepageSection(ready) {
  const keyboard = useRef(null);
  useLayoutEffect(() => {
    let active = true;
    if (keyboard.current === null) {
      keyboard.current = false;
      try {
        keyboard.current =
          sessionStorage.getItem("cedar-home-section-input") === "keyboard";
        sessionStorage.removeItem("cedar-home-section-input");
      } catch {
        // Storage is optional; local keyboard events still establish modality.
      }
    }
    function onKey(event) {
      if (["Tab", "Enter", " "].includes(event.key)) keyboard.current = true;
    }
    function onPointer() {
      keyboard.current = false;
    }
    function align() {
      if (!active || window.location.pathname !== "/") return;
      const id = window.location.hash.slice(1);
      if (!["services", "doctors", "about", "contact"].includes(id)) return;
      const section = document.getElementById(id);
      if (section)
        section.dataset.sectionFocus = keyboard.current
          ? "keyboard"
          : "programmatic";
      section?.focus({ preventScroll: true });
      section?.scrollIntoView({ behavior: "instant", block: "start" });
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    align();
    document.fonts.ready.then(align);
    window.addEventListener("hashchange", align);
    window.addEventListener("pageshow", align);
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("hashchange", align);
      window.removeEventListener("pageshow", align);
    };
  }, [ready]);
}

function HomepageLayout({ onPreview, result, retry, demo = false }) {
  useHomepageSection(result.status !== "loading");
  return (
    <div className="cedar-home">
      {import.meta.env.DEV && (
        <div
          className="container home-preview-bar"
          aria-label="Development preview mode"
        >
          <span>
            {demo
              ? "Design demo: fictional people and hours. Nothing is submitted."
              : "Live data: the existing API response, including errors."}
          </span>
          <div>
            <a href="/" aria-current={demo ? "page" : undefined}>
              Demo
            </a>
            <a href="/?preview=live" aria-current={!demo ? "page" : undefined}>
              Live data
            </a>
          </div>
        </div>
      )}
      <Hero onPreview={onPreview} result={result} onRetry={retry} />
      <HomeContent result={result} />
    </div>
  );
}
function ConnectedHomepage({ onPreview }) {
  const { result, retry } = useSchedule();
  return <HomepageLayout onPreview={onPreview} result={result} retry={retry} />;
}
function DevelopmentHomepage({ onPreview }) {
  const [schedule, setSchedule] = useState(null);
  useEffect(() => {
    let active = true;
    if (import.meta.env.DEV)
      import("../dev/homepageDemo.js").then((module) => {
        if (active) setSchedule(module.homepageDemoSchedule);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <HomepageLayout
      onPreview={onPreview}
      demo
      result={{ status: schedule ? "success" : "loading", schedule }}
    />
  );
}
export default function HomePage({ onPreview }) {
  return isHomepageDemo(
    import.meta.env.DEV,
    window.location.pathname,
    window.location.search,
  ) ? (
    <DevelopmentHomepage onPreview={onPreview} />
  ) : (
    <ConnectedHomepage onPreview={onPreview} />
  );
}
