import React from "react";
import { createRoot } from "react-dom/client";
import OperationsPanel from "../../src/components/OperationsPanel.jsx";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
const state = {
  revision: 1,
  head: 0,
  isAdmin: true,
  deliveryConfigured: false,
  deliveries: [],
  scopes: [
    {
      id: "synthetic-clinic",
      name: "Synthetic Clinic",
      kind: "clinic",
      active: true,
      access: { view: true, edit: true, publish: true },
    },
  ],
  professionals: [],
  sessions: [],
  exceptions: [],
  hours: [],
  grants: [],
};
const api = {
  operationalState: async () => structuredClone(state),
  affectedBookings: async () => ({ bookings: [] }),
  staffDirectory: async () => ({ staff: [] }),
};
createRoot(document.getElementById("root")).render(
  <OperationsPanel
    api={api}
    mode="schedule"
    initialScheduleMode={params.has("dated") ? "dated" : "weekly"}
    onSensitiveAction={async () => {
      throw Error(
        "This synthetic layout fixture does not authorize mutations.",
      );
    }}
  />,
);
