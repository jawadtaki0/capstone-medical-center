import Hero from "../components/Hero.jsx";
import GrainientBackdrop from "../components/GrainientBackdrop.jsx";
import {
  VisitInfo,
  Doctors,
  Services,
  About,
  Contact,
} from "../components/HomeSections.jsx";
import useSchedule from "../hooks/useSchedule.js";

export default function HomePage({ onPreview }) {
  const { result, retry } = useSchedule();
  return (
    <>
      <Hero onPreview={onPreview} />
      <div className="home-content">
        <GrainientBackdrop />
        <div className="home-content-inner">
          <VisitInfo result={result} />
          <Doctors onPreview={onPreview} result={result} onRetry={retry} />
          <Services onPreview={onPreview} />
          <About />
          <Contact />
        </div>
      </div>
    </>
  );
}
