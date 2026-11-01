import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../components/doctorDirectory.css";
import "./preview.css";
import PublicPreview from "./PublicPreview.jsx";

// Separate development-only HTML entry. Normal App and production entry do not
// import this preview or its synthetic memory store.
createRoot(document.getElementById("root")).render(<PublicPreview />);
