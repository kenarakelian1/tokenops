import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL only auto-registers its own `afterEach(cleanup)` when `afterEach`
// exists as a *global* (i.e. `test.globals: true`), which this package does
// not set. Without this, `render()` in one test never unmounts: the mounted
// `App` (and its 2s poll interval) leaks into every later test in the file,
// each one silently re-polling `globalThis.tokenops` after a later test has
// already replaced it with a new mock -- a source of flaky "found multiple
// elements" failures that only shows up once a run is slow enough for a
// leaked poll to land mid-test.
afterEach(cleanup);
