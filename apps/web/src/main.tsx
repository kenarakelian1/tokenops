import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      {/*
        The installed @clerk/react (6.12.10) does not read
        VITE_CLERK_PUBLISHABLE_KEY from import.meta.env itself — its types
        (and `tsc`) require `publishableKey` explicitly, and its bundle has
        no import.meta.env reference at all. Vite still does the env
        plumbing: it exposes VITE_-prefixed vars on import.meta.env, we just
        have to hand the value to ClerkProvider ourselves.
      */}
      <ClerkProvider
        publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
        afterSignOutUrl="/"
      >
        <App />
      </ClerkProvider>
    </BrowserRouter>
  </StrictMode>,
);
