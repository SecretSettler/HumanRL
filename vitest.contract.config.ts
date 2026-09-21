import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.contract.test.ts", "packages/**/*.contract.test.ts"],
    passWithNoTests: false,
  },
});
