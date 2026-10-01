import { useRef, useState } from "react";
import Header from "./components/Header.jsx";
import { Footer } from "./components/HomeSections.jsx";
import PrototypeDialog from "./components/PrototypeDialog.jsx";
import HomePage from "./pages/HomePage.jsx";
import SchedulePage from "./pages/SchedulePage.jsx";
import DoctorsPage from "./pages/DoctorsPage.jsx";

export default function App() {
  const dialog = useRef(null);
  const [previewAction, setPreviewAction] = useState("");
  const pathname = window.location.pathname.replace(/\/$/, "");
  const onSchedulePage = pathname === "/schedule";
  const onDoctorsPage = pathname === "/doctors";
  function showPreview(action) {
    setPreviewAction(action);
    dialog.current?.showModal();
  }
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <Header onPreview={showPreview} onSchedulePage={onSchedulePage} onDoctorsPage={onDoctorsPage} />
    <main id="main" tabIndex={-1}>
      {onDoctorsPage ? <DoctorsPage /> : onSchedulePage ? <SchedulePage onPreview={showPreview} /> : <HomePage onPreview={showPreview} />}
    </main>
    <Footer />
    <PrototypeDialog dialogRef={dialog} action={previewAction} />
  </>;
}
