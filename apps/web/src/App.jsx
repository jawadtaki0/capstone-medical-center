import "./pages/publicInteriors.css";
import WebsiteRequestPage from "./pages/WebsiteRequestPage.jsx";
import { accountRequest } from "./patient-account-client.js";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import LoadingStatus from "../../../shared/ui/LoadingStatus.jsx";
import PublicPage from "./components/PublicPage.jsx";
import PublicShell from "./components/PublicShell.jsx";
import PhoneVerificationNotice from "./components/PhoneVerificationNotice.jsx";
import { requestSelectionUrl } from "./request-selection.js";
import { isHomepageDemo, isHomepageDemoSession } from "./homepage-preview.js";
import PrototypeDialog from "./components/PrototypeDialog.jsx";
import HomePage from "./pages/HomePage.jsx";
import SchedulePage from "./pages/SchedulePage.jsx";
import DoctorsPage from "./pages/DoctorsPage.jsx";
import ServicePage from "./pages/ServicePage.jsx";
import { services } from "./data/homeContent.js";

const patientAccounts = import.meta.env.VITE_PATIENT_ACCOUNTS === "1";
const PatientAccountPage = lazy(() => import("./pages/PatientAccountPage.jsx"));

export default function App() {
  const dialog = useRef(null);
  const [previewAction, setPreviewAction] = useState("");
  const [account, setAccount] = useState(undefined);
  const pathname = window.location.pathname.replace(/\/$/, "");
  const onRequestPage = ["/request", "/track"].includes(pathname);
  const onSchedulePage = pathname === "/schedule";
  const onDoctorsPage = pathname === "/doctors";
  const onHomePage = pathname === "";
  const onAccountPage = patientAccounts && pathname === "/account";
  useEffect(() => {
    if (!patientAccounts) return;
    let current = true;
    accountRequest("session").then(
      (result) => {
        if (current) setAccount(result.account);
      },
      () => {
        if (current) setAccount(null);
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const service = services.find(
    (item) => pathname === `/services/${item.slug}`,
  );
  useEffect(() => {
    const descriptions = {
      "": [
        "Cedar Medical Center",
        "Explore the center’s published professionals and attendance windows.",
      ],
      "/doctors": [
        "Doctors & specialists · Cedar Medical Center",
        "Find published doctors and specialists at Cedar Medical Center.",
      ],
      "/schedule": [
        "Schedule · Cedar Medical Center",
        "Browse published professional sessions and center opening hours.",
      ],
      "/request": [
        "Request a clinic session · Cedar Medical Center",
        "Submit a clinic attendance request for staff review.",
      ],
      "/track": [
        "Private request tracking · Cedar Medical Center",
        "Private request status. A tracking link is required.",
      ],
      ...(patientAccounts
        ? {
            "/account": [
              "Patient account · Cedar Medical Center",
              "Manage your Cedar online account.",
            ],
          }
        : {}),
    };
    const [title, description] = (service
      ? [`${service.title} · Cedar Medical Center`, service.description]
      : descriptions[pathname]) ?? [
      "Page not found · Cedar Medical Center",
      "This page could not be found.",
    ];
    document.title = title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", description);
    // Review remains unindexed. No patient values or URL tokens enter metadata.
  }, [pathname, service]);
  function showPreview(action, session) {
    if (
      isHomepageDemo(import.meta.env.DEV, pathname, window.location.search) ||
      isHomepageDemoSession(session)
    ) {
      setPreviewAction("Design demo — nothing submitted");
      dialog.current?.showModal();
      return;
    }
    if (
      ["Book an appointment", "Book appointment (prototype)"].includes(
        action,
      ) &&
      (import.meta.env.VITE_WEBSITE_REQUESTS === "1" ||
        import.meta.env.VITE_HOSTED_REVIEW === "1" ||
        import.meta.env.VITE_HOSTED_CAPSTONE === "1")
    ) {
      window.location.href = requestSelectionUrl(session);
      return;
    }
    setPreviewAction(action);
    dialog.current?.showModal();
  }
  return (
    <>
      <PublicShell
        homePage={onHomePage}
        onPreview={showPreview}
        onRequestPage={onRequestPage}
        onSchedulePage={onSchedulePage}
        onDoctorsPage={onDoctorsPage}
        serviceSlug={service?.slug}
        patientAccountLink={
          patientAccounts ? (account ? "My account" : "Sign in") : undefined
        }
        overlay={<PrototypeDialog dialogRef={dialog} action={previewAction} />}
      >
        {onAccountPage ? (
          <Suspense fallback={<LoadingStatus label="Loading account…" />}>
            <PatientAccountPage account={account} onAccount={setAccount} />
          </Suspense>
        ) : onRequestPage ? (
          <WebsiteRequestPage
            tracking={pathname === "/track"}
            account={patientAccounts ? account : null}
          />
        ) : onDoctorsPage ? (
          <DoctorsPage />
        ) : onSchedulePage ? (
          <SchedulePage onPreview={showPreview} />
        ) : service ? (
          <ServicePage slug={service.slug} />
        ) : onHomePage ? (
          <>
            {account && !account.bookingPhone && (
              <div className="container home-phone-notice">
                <PhoneVerificationNotice />
              </div>
            )}
            <HomePage onPreview={showPreview} />
          </>
        ) : (
          <PublicPage className="public-not-found">
            <section className="container">
              <h1>Page not found</h1>
              <p>
                The page may have moved. Choose a page from the navigation or
                return home.
              </p>
              <a className="button button-primary" href="/">
                Return home
              </a>
              <a className="button button-secondary" href="/schedule">
                View schedule
              </a>
            </section>
          </PublicPage>
        )}
      </PublicShell>
    </>
  );
}
