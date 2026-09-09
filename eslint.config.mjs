import { FlatCompat } from "@eslint/eslintrc";

// ESLint flat config.
//
// Two things forced this file into existence with the Next.js 16 upgrade:
// `next lint` was removed, so `npm run lint` now calls the ESLint CLI
// directly and needs a config of its own; and @next/eslint-plugin-next now
// defaults to flat config, since ESLint 10 drops the legacy .eslintrc format
// entirely.
//
// FlatCompat is the bridge that lets a flat config consume the older
// "extends" style presets that eslint-config-next still ships.
//
// Note that `next build` no longer runs lint at all in Next.js 16. Linting
// is now something you run deliberately, which means a lint failure can no
// longer block a deploy, and equally that nothing will catch one for you.
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "**/*.tsbuildinfo",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];
