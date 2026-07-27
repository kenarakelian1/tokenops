import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) => c.json({ ok: true }));

/** Friendly landing so visiting the API host is not a bare 404. */
healthRoutes.get("/", (c) =>
  c.json({
    service: "tokenops-api",
    ok: true,
    health: "/health",
    docs: "https://github.com/kenarakelian1/tokenops",
    dashboard: "https://tokenops-web-production.up.railway.app",
    hint: "This is the API. Open the dashboard URL in your browser to sign in.",
  }),
);
