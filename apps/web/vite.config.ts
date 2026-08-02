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
// needs.
//
// loadEnv's third argument is matched by `startsWith`, and that's the actual
// barrier against leaking secrets: ["VITE_", "CLERK_PUBLISHABLE_KEY"] loads
// only vars whose name starts with one of those two strings.
// CLERK_SECRET_KEY does not start with "CLERK_PUBLISHABLE_KEY", so it is
// never loaded into `rootEnv` in the first place — not merely "not read out
// of it". (Vite itself refuses an empty envPrefix for exactly this reason;
// loadEnv's prefix argument has no built-in guard, so this supplies one.)
export default defineConfig(({ mode, command }) => {
  const repoRoot = path.resolve(__dirname, "../..");
  const rootEnv = loadEnv(mode, repoRoot, ["VITE_", "CLERK_PUBLISHABLE_KEY"]);
  const clerkPublishableKey =
    rootEnv.VITE_CLERK_PUBLISHABLE_KEY || rootEnv.CLERK_PUBLISHABLE_KEY || "";

  // Only `vite build` ships a bundle. Failing here — instead of quietly
  // defaulting to "" — turns a keyless production build into a loud
  // failure instead of a green build/deploy that ships a dashboard which
  // white-screens on Clerk's MissingPublishableKey at runtime. Dev/test
  // runs also resolve this config (vitest uses command "serve"), so they
  // are deliberately left unaffected — local iteration and `vitest` don't
  // need a real Clerk key.
  if (command === "build" && !clerkPublishableKey) {
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY (or CLERK_PUBLISHABLE_KEY) must be set to build " +
        "@tokenops/web — it is baked into the client bundle at build time and " +
        "ClerkProvider throws MissingPublishableKey without it. Set it as a " +
        "build-time env var (see deploy/web.Dockerfile's VITE_CLERK_PUBLISHABLE_KEY ARG).",
    );
  }

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
