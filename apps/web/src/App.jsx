import { useEffect, useState } from "react";

const plannedAreas = [
  "Public medical-center pages",
  "Patient accounts and tracking",
  "Shared appointment capacity",
  "Clinic and lab operations",
  "Billing and approved lab PDFs",
];

export default function App() {
  const [health, setHealth] = useState({ state: "checking", database: "unknown" });

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }
        return response.json();
      })
      .then((data) => setHealth({ state: data.status, database: data.database }))
      .catch((error) => {
        if (error.name !== "AbortError") {
          setHealth({ state: "unavailable", database: "unknown" });
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">CSC599 applied capstone</p>
        <h1>Medical Center System</h1>
        <p className="summary">
          A minimal React and Express foundation for a public website, patient portal,
          and internal clinic and lab workflows.
        </p>
        <div className="status" aria-live="polite">
          <span className={`status-dot status-${health.state}`} aria-hidden="true" />
          API: {health.state} · MongoDB: {health.database}
        </div>
      </header>

      <section aria-labelledby="foundation-title">
        <h2 id="foundation-title">Foundation scope</h2>
        <ul className="scope-grid">
          {plannedAreas.map((area) => (
            <li key={area}>{area}</li>
          ))}
        </ul>
      </section>

      <section className="notice" aria-labelledby="notice-title">
        <h2 id="notice-title">Development boundary</h2>
        <p>
          This foundation contains no patient records or clinical functionality. Development
          will use synthetic data only. Bookings will represent capacity-limited doctor windows,
          not guaranteed visit times.
        </p>
      </section>
    </main>
  );
}

