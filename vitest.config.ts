import { defineConfig } from "vitest/config";

// Plain Node environment - the profitability engine is pure calculation code
// (no DOM, no React), see the "PURE CALCULATION LAYER" note at the top of
// src/lib/profitability.ts. Tests live next to the lib code they cover.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
