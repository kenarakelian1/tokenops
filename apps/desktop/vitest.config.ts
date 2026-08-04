import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: that file sets `root` to
// src/renderer for the Vite renderer build, which would silently scope
// vitest's test discovery to src/renderer too -- any test added later under
// src/main/**/*.test.ts or src/preload/**/*.test.ts would never be found.
// This file has no `root` override, so vitest (run standalone or picked up
// by the root vitest.workspace.ts) sees the whole package tree.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
