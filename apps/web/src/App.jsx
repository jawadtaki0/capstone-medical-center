import { useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Hero from "./components/Hero.jsx";
import { VisitInfo, Doctors, Services, About, Contact, Footer } from "./components/HomeSections.jsx";
import PrototypeDialog from "./components/PrototypeDialog.jsx";
import GrainientBackdrop from "./components/GrainientBackdrop.jsx";
import SchedulePage from "./pages/SchedulePage.jsx";

export default function App() {
  const dialog = useRef(null);
  const [previewAction, setPreviewAction] = useState("");
  const onSchedulePage = window.location.pathname === "/schedule";
  function showPreview(action) {
    setPreviewAction(action);
    dialog.current?.showModal();
  }
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <Header onPreview={showPreview} onSchedulePage={onSchedulePage} />
    <main id="main" tabIndex={-1}>
      {onSchedulePage ? <SchedulePage onPreview={showPreview} /> : <>
        <Hero onPreview={showPreview} />
        <div className="home-content">
          <GrainientBackdrop />
          <div className="home-content-inner">
            <VisitInfo />
            <Doctors onPreview={showPreview} />
            <Services onPreview={showPreview} />
            <About />
            <Contact />
          </div>
        </div>
      </>}
    </main>
    <Footer />
    <PrototypeDialog dialogRef={dialog} action={previewAction} />
  </>;
}
