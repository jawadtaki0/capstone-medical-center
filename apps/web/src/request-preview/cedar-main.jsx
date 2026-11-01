import React from "react";
import { createRoot } from "react-dom/client";
import "../../../staff/src/styles.css";
import "./preview.css";
import "./cedar-preview.css";
import CedarPreview from "./CedarPreview.jsx";

// Presentation-only entry: imports staff theme CSS, not App/auth/IPC/credentials.
createRoot(document.getElementById("root")).render(<CedarPreview />);
