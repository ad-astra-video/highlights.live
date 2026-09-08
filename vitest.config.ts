import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/server/test/**/*.test.ts", "webapp/src/**/*.test.ts?(x)"],
    environment: "node",
  },
});
