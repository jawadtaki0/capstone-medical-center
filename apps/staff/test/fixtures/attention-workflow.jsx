import { useState } from "react";
import { createRoot } from "react-dom/client";
import Workspace from "../../src/components/Workspace.jsx";
import "../../src/styles.css";
let counts = {
    requestsAwaitingDecision: 0,
    messagesToSend: 2,
    todaysBookings: 0,
    unpublishedChanges: 0,
    publicationDeliveryProblems: 0,
  },
  failure = false;
const api = {
  operationalSummary: async () => {
    if (failure) throw Error("Synthetic summary unavailable");
    return {
      counts,
      activity: [],
      capabilities: {
        requests: true,
        patients: true,
        book: true,
        bookingView: true,
      },
    };
  },
  websiteRequests: async ({ action }) =>
    action === "list"
      ? { requests: [], nextCursor: null }
      : action === "notices"
        ? { notices: [], nextCursor: null }
        : { refreshed: true },
};
function Fixture() {
  const [expired, setExpired] = useState(false);
  const refresh = () => document.dispatchEvent(new Event("visibilitychange"));
  return (
    <>
      <p>SYNTHETIC COMPONENT ONLY — no server or stored records.</p>
      <button
        onClick={() => {
          failure = false;
          counts = { ...counts, messagesToSend: 0 };
          refresh();
        }}
      >
        Resolve synthetic messages
      </button>
      <button
        onClick={() => {
          failure = true;
          refresh();
        }}
      >
        Fail summary read
      </button>
      <button onClick={() => setExpired(true)}>Expire authorization</button>
      <Workspace
        api={api}
        user={{
          id: "synthetic",
          username: "synthetic",
          roles: ["Receptionist"],
        }}
        workspace={{ roles: ["Receptionist"] }}
        timing={{ expired }}
        onError={() => {}}
        onSensitiveAction={async () => {
          throw Error("No mutations in this fixture");
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
