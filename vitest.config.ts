import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // The subpath export must come BEFORE the bare alias: Vite matches aliases
      // by prefix, so "@highlights/events" would otherwise rewrite the subpath to
      // `<index.ts>/training` (ADAAAA-8321 imports the fingerprint helpers).
      "@highlights/events/training": fileURLToPath(new URL("./packages/events/src/training.ts", import.meta.url)),
      "@highlights/events": fileURLToPath(new URL("./packages/events/src/index.ts", import.meta.url)),
      "@highlights/livepeer-session": fileURLToPath(new URL("./packages/livepeer-session/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "services/email/test/**/*.test.ts",
      "services/server/test/**/*.test.ts",
      "services/media/test/**/*.test.ts",
      "webapp/src/**/*.test.ts?(x)",
      // .mts tests are ESM-only by extension; match them explicitly so files
      // like JobDetail.clips.test.mts are not silently skipped (ADAAAA-8312).
      // Scoped to all of webapp/ (not just webapp/src/) because four node-env
      // .mts tests live at the webapp root and were skipped the same way
      // (ADAAAA-8313): analysis-toolbar-sticky, content-referral-utm,
      // jobdetail-role-gate, render-smoke. They import only node builtins +
      // react-dom/server, so they run fine under this config's node env; they
      // are not browser/jsdom-only and must not be excluded.
      "webapp/**/*.test.mts",
    ],
    environment: "node",
    testTimeout: 30000,
    // node:sqlite (and other experimental builtins) are not in Vite's
    // default external list — load them from Node at runtime, not via Vite.
    server: { deps: { external: [/^node:/] } },
  },
});
