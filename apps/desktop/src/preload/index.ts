// Preload runs inside a sandboxed, context-isolated renderer (sandbox: true,
// contextIsolation: true — see src/main/window.ts). Nothing is bridged to
// the page yet: the placeholder renderer (Task 2) needs no IPC surface, and
// wiring one up here before it's needed would just be unused attack surface.
// Task 4 adds the contextBridge API the real UI reads local stats through.
export {};
