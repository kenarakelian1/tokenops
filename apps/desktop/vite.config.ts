import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// Renderer only -- main and preload are compiled separately by `tsc` (see
// tsconfig.json) into plain CommonJS, which Electron loads directly.
export default defineConfig({
  root: path.resolve(here, "src/renderer"),
  // BrowserWindow loads dist/renderer/index.html via loadFile (file://), so
  // asset URLs must be relative -- an absolute "/assets/..." base resolves
  // to the filesystem root under file:// and 404s.
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(here, "dist/renderer"),
    emptyOutDir: true,
  },
});
