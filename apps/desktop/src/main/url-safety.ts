const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Only http(s) is ever handed to the OS shell. `shell.openExternal` with an
 * unvalidated URL is a known Windows attack path -- `file:`, UNC paths
 * (`\\host\share`), and registered custom protocol handlers can all launch
 * something other than a browser tab.
 *
 * Shared by window.ts (window-open / will-navigate handling) and ipc.ts (the
 * "open dashboard" channel) so there is exactly one implementation of this
 * check in the app -- a second, drifted copy is exactly how this kind of
 * validation gets silently bypassed on one call site while "fixed" on
 * another.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
