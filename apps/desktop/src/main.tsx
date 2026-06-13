import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./components/ThemeSwitcher";
import "./index.css";

// Paint the persisted theme before first render (no flash of the wrong palette).
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
