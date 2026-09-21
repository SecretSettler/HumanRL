import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["apps/**/*.test.ts", "apps/**/*.test.mjs", "packages/**/*.test.ts"],
    passWithNoTests: false,
  },
});
