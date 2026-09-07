import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Точка входа проверяется сборкой; модульная логика покрывается тестами отдельно.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
    },
  },
});
