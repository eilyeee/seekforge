import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./components/ThemeSwitcher";
import { initLocale } from "./lib/i18n";
import "./index.css";

// Paint the persisted theme + locale before first render.
initTheme();
initLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
