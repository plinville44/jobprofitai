import path from "node:path";
import { defineConfig } from "vitest/config";

// Plain Node environment - the profitability engine is pure calculation code
// (no DOM, no React), see the "PURE CALCULATION LAYER" note at the top of
// src/lib/profitability.ts. Tests live next to the lib code they cover.
//
// The `@` alias mirrors tsconfig.json's `paths` setting so test files can
// import application modules exactly the way the application does. Without
// it, anything importing "@/lib/..." fails to resolve under Vitest even
// though it compiles fine in Next.js.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
