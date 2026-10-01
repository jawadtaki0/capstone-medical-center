import { useEffect, useState } from "react";
import DirectorySearch from "../components/DirectorySearch.jsx";
import ProfessionalCard from "../components/ProfessionalCard.jsx";
import GrainientPage from "../components/GrainientPage.jsx";
import useProfessionals from "../hooks/useProfessionals.js";
import { filterProfessionals } from "../lib/directory.js";
import "../components/doctorDirectory.css";

export function DirectoryContent({ result, onRetry }) {
  const [query, setQuery] = useState("");
  const professionals = filterProfessionals(result.professionals, query);
  const loaded = result.status === "success";
  const directoryEmpty = loaded && result.professionals.length === 0;
  return <>
    <DirectorySearch query={query} onQueryChange={setQuery} resultsId="directory-results" />
    <p className="directory-status" role="status" aria-live="polite" aria-atomic="true">
      {result.status === "loading" ? "Loading the directory…" : result.status === "error" ? "The directory could not be loaded." : `${professionals.length} ${professionals.length === 1 ? "professional" : "professionals"} shown.`}
    </p>
    <div id="directory-results" aria-busy={result.status === "loading"}>
      {result.status === "loading" && <div className="directory-state"><h2>Loading doctors and specialists…</h2><p>The public directory will appear here shortly.</p></div>}
      {result.status === "error" && <div className="directory-state">
        <h2>We couldn’t load the directory.</h2><p>Please try again.</p>
        <button type="button" className="button button-primary" onClick={onRetry}>Try again</button>
      </div>}
      {directoryEmpty && <div className="directory-state"><h2>No professionals are available yet.</h2><p>Please check again later.</p></div>}
      {loaded && !directoryEmpty && professionals.length === 0 && <div className="directory-state"><h2>No matching professionals.</h2><p>Try another name or specialty, or clear the search.</p></div>}
      {loaded && professionals.length > 0 && <div className="professional-grid">
        {professionals.map((professional) => <ProfessionalCard professional={professional} key={professional.id} />)}
      </div>}
    </div>
  </>;
}

export default function DoctorsPage() {
  const { result, retry } = useProfessionals();
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Doctors & Specialists · Cedar Medical Center";
    return () => { document.title = previousTitle; };
  }, []);
  return <GrainientPage className="doctors-page">
    <div className="container directory-shell">
      <div className="directory-intro">
        <p className="eyebrow">OUR CARE TEAM</p>
        <h1>Doctors &amp; specialists</h1>
        <p>Find a professional by name or specialty.</p>
      </div>
      <DirectoryContent result={result} onRetry={retry} />
    </div>
  </GrainientPage>;
}
