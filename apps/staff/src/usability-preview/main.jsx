import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import Preview from "./Preview.jsx";
import "./preview.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
