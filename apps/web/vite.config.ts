import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Clerk's CLI writes CLERK_PUBLISHABLE_KEY (no VITE_ prefix) into the
// monorepo-root .env.local. Vite only auto-exposes vars prefixed VITE_, and
// only from files under this package's own root, so that value is invisible
// to the client bundle by default. Point envDir at the repo root (so a
// VITE_CLERK_PUBLISHABLE_KEY placed there, or set as a real deploy-time env
// var, is picked up normally) and, for the common case where only the
// unprefixed key exists, re-expose it under the VITE_ name ClerkProvider
// reads. CLERK_SECRET_KEY is never touched here, so it can't leak to the
// client bundle.
export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "../..");
  const rootEnv = loadEnv(mode, repoRoot, "");
  const clerkPublishableKey =
    rootEnv.VITE_CLERK_PUBLISHABLE_KEY ?? rootEnv.CLERK_PUBLISHABLE_KEY ?? "";

  return {
    plugins: [react()],
    envDir: repoRoot,
    server: {
      port: 5173,
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
    define: {
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(clerkPublishableKey),
    },
  };
});
