import GrainientBackdrop from "./GrainientBackdrop.jsx";
import "./grainientPage.css";

// Default shell for new public pages. Home keeps its approved below-hero shell.
export default function GrainientPage({ children, className = "" }) {
  return <div className={`grainient-page ${className}`}>
    <GrainientBackdrop />
    <div className="grainient-page__content">{children}</div>
  </div>;
}
