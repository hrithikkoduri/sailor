import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "./app/theme-provider";
import { DebugProvider } from "./features/debug/debug-provider";
import App from "./app/App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <DebugProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </DebugProvider>
      </ThemeProvider>
    </MotionConfig>
  </StrictMode>,
);
