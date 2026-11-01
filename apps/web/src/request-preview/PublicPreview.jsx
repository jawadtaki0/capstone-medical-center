import { useEffect, useState } from "react";
import Header from "../components/Header.jsx";
import { Footer } from "../components/HomeSections.jsx";
import GrainientPage from "../components/GrainientPage.jsx";
import RequestForm from "./RequestForm.jsx";
import TrackingView from "./TrackingView.jsx";
import {
  PROFESSIONALS,
  SESSIONS,
  SAMPLE_PATIENT,
  publicTracking,
} from "./model.js";
import { previewStore } from "./store.js";
import { usePreview } from "./store.js";

export default function PublicPreview() {
  const state = usePreview(),
    [hash, setHash] = useState(window.location.hash),
    [language, setLanguage] = useState("en"),
    [scenario, setScenario] = useState("ready"),
    [toast, setToast] = useState("");
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const tracking = hash.startsWith("#track/"),
    token = hash.slice(7),
    request = tracking
      ? state.requests.find((r) => r.trackingToken === token)
      : null;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="preview-banner" role="note">
        <div>
          <strong>VISUAL PREVIEW · SYNTHETIC DATA ONLY</strong>
          <span>
            No real submission, booking, private link or WhatsApp delivery.
            Browser-memory simulation; reload may reset the preview.
          </span>
        </div>
        <nav aria-label="Preview pages">
          <a href="/request-preview.html#request">Request flow</a>
          <a href="/request-preview.html#track/demo-not-a-secret-2">
            Sample tracking
          </a>
          <a
            href="/cedar-request-preview.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            Cedar inbox ↗
          </a>
        </nav>
      </div>
      <div
        onClickCapture={(e) => {
          const a = e.target.closest("a");
          if (a && !a.getAttribute("href")?.startsWith("#")) {
            e.preventDefault();
            setToast(
              "Existing website navigation is unchanged. This visual preview covers request and tracking pages only.",
            );
          }
        }}
      >
        <Header
          onPreview={() => {
            window.location.hash = "request";
          }}
          onRequestPage
        />
      </div>
      <GrainientPage className="request-preview-page">
        <main id="main" tabIndex={-1} className="container request-shell">
          <div className="request-preview-tools">
            <span>Design review · no backend integration</span>
            {!tracking && (
              <label>
                Preview state
                <select
                  aria-label="Preview state"
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                >
                  <option value="ready">Ready</option>
                  <option value="loading">Loading</option>
                  <option value="unavailable">Unavailable</option>
                  <option value="empty">No sessions</option>
                </select>
              </label>
            )}
            {!tracking && (
              <label>
                Language
                <select
                  aria-label="Website preview language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
            )}
          </div>
          {tracking ? (
            <TrackingView
              key={token}
              data={request ? publicTracking(request) : null}
              onLanguage={setLanguage}
            />
          ) : (
            <div dir={language === "ar" ? "rtl" : "ltr"} lang={language}>
              <RequestForm
                preview
                professionals={PROFESSIONALS}
                sessions={SESSIONS}
                sample={SAMPLE_PATIENT}
                initialDate="2026-11-02"
                trackingBase="/request-preview.html#track/"
                submitRequest={(...args) => previewStore.submit(...args)}
                language={language}
                onLanguage={setLanguage}
                scenario={scenario}
                onToast={setToast}
              />
            </div>
          )}
        </main>
      </GrainientPage>
      <Footer />
      {toast && (
        <div className="request-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
