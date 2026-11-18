import { useState } from "react";

const names = {
  queued: "Code to send",
  prepared: "Code to send",
  opened: "Draft opened",
  sent: "Awaiting code entry",
  verified: "Verified",
  used: "Recovery completed",
  expired: "Expired",
};

export default function PatientPhoneQueue({ api, queue, refresh, onError }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [past, setPast] = useState(false);
  async function action(row) {
    setBusy(true);
    setMessage("");
    try {
      if (row.state === "opened") {
        await api.websiteRequests({
          action: "phoneVerification",
          phoneAction: "sent",
          id: row.id,
        });
        setMessage("Manual send recorded. The patient can enter the code.");
      } else {
        const result = await api.openPatientPhoneWhatsApp({ id: row.id });
        setMessage(
          result.warning ??
            "Draft opened. Mark it sent after sending the message in WhatsApp.",
        );
      }
    } catch (error) {
      setMessage(error.message);
      onError?.(error);
    } finally {
      refresh();
      setBusy(false);
    }
  }
  const rows = (queue?.rows ?? []).filter(
    (row) =>
      (past || !["expired", "verified", "used"].includes(row.state)) &&
      [row.account, row.phone].some((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );
  return (
    <section aria-label="Phone verification">
      <details>
        <summary>Search and filters</summary>
        <label className="request-field">
          Account or phone
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={past}
            onChange={(event) => setPast(event.target.checked)}
          />{" "}
          Show past verifications
        </label>
      </details>
      {message && <p role="status">{message}</p>}
      {!queue ? (
        <p>Refresh requests to load phone verifications.</p>
      ) : rows.length ? (
        <ul className="patient-phone-queue">
          {rows.map((row) => (
            <li className="request-note" key={row.id}>
              <div>
                <strong>{row.account}</strong>
                {row.recovery && <small> · Account recovery</small>}
                <p>
                  <bdi>{row.phone}</bdi> · {names[row.state]}
                </p>
              </div>
              {["queued", "prepared", "opened"].includes(row.state) && (
                <button
                  className="staff-button staff-button-primary"
                  disabled={busy}
                  onClick={() => action(row)}
                >
                  {row.state === "opened" ? "Mark sent" : "Open WhatsApp"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No phone verifications to show.</p>
      )}
    </section>
  );
}
