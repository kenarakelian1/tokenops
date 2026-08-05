import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// Deliberately separate from vite.config.ts: that file sets `root` to
// src/renderer for the Vite renderer build, which would silently scope
// vitest's test discovery to src/renderer too -- any test added later under
// src/main/**/*.test.ts or src/preload/**/*.test.ts would never be found.
// This file has no `root` override, so vitest (run standalone or picked up
// by the root vitest.workspace.ts) sees the whole package tree.
export default defineConfig({
  // Needed for App.test.tsx's JSX (react's automatic runtime); harmless for
  // src/main/**/*.test.ts and src/preload/**/*.test.ts, which contain no JSX.
  plugins: [react()],
  test: {
    passWithNoTests: true,
    // App.test.tsx renders React components with @testing-library/react,
    // which needs a DOM (window/document). main/**/*.test.ts and
    // preload/**/*.test.ts, if any are added later, run fine under jsdom too
    // -- they don't touch the DOM at all, so the environment is a no-op for
    // them.
    environment: "jsdom",
    setupFiles: [path.resolve(here, "vitest.setup.ts")],
  },
});
