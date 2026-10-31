import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import OneDateEditor from "../../src/components/OneDateEditor.jsx";
import "../../src/styles.css";
import "../../src/components/operations.css";
const session = (id, professionalId, capacity) => ({
  id,
  scopeId: "clinic",
  professionalId,
  weekday: 1,
  startTime: "09:00",
  endTime: "11:00",
  capacity,
  status: "active",
  appointmentRequired: false,
});
const state = {
  scopes: [
    {
      id: "clinic",
      name: "Synthetic Clinic",
      kind: "clinic",
      active: true,
      access: { edit: true },
    },
    {
      id: "lab",
      name: "Synthetic Laboratory",
      kind: "service",
      active: true,
      access: { edit: true },
    },
  ],
  professionals: [
    {
      id: "one",
      name: "Synthetic One",
      scopeIds: ["clinic"],
      active: true,
      canEdit: true,
    },
    {
      id: "two",
      name: "Synthetic Two",
      scopeIds: ["clinic"],
      active: true,
      canEdit: true,
    },
  ],
  sessions: [session("s1", "one", 3), session("s2", "two", null)],
  exceptions: [],
};
window.calls = [];
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button onClick={() => setOpen(true)}>Change one date</button>
      {open && (
        <OneDateEditor
          initial={{
            id: "exception:dummy",
            date: "2026-11-02",
            scopeId: "",
            closed: true,
            sessions: [],
          }}
          state={state}
          onClose={() => setOpen(false)}
          onSave={async (record, revision) => {
            window.calls.push({ record, revision });
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
