import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/sora";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
