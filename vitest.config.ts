import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@highlights/events": fileURLToPath(new URL("./packages/events/src/index.ts", import.meta.url)),
      "@highlights/livepeer-session": fileURLToPath(new URL("./packages/livepeer-session/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/server/test/**/*.test.ts", "webapp/src/**/*.test.ts?(x)"],
    environment: "node",
    testTimeout: 30000,
  },
});
