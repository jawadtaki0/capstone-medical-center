import { useEffect, useState } from "react";
import LatticeLoader from "./react-bits/LatticeLoader.jsx";
import "./loading-status.css";

// Foreground work only. Background refreshes retain their populated content.
export default function LoadingStatus({
  label = "Loading…",
  wakeHint = false,
  language = "en",
}) {
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    setLongWait(false);
    if (!wakeHint) return;
    const timer = setTimeout(() => setLongWait(true), 10000);
    return () => clearTimeout(timer);
  }, [wakeHint, label]);
  return (
    <div className="cedar-loading">
      <LatticeLoader
        label={label}
        showTimer={false}
        color="#00749b"
        glow={false}
      />
      {longWait && (
        <p role="status">
          {language === "ar"
            ? "قد يكون خادم المراجعة قيد التشغيل. أبقِ هذه الصفحة مفتوحة؛ بياناتك المدخلة محفوظة."
            : "The review server may be waking. Keep this page open; your entered details are retained."}
        </p>
      )}
    </div>
  );
}
